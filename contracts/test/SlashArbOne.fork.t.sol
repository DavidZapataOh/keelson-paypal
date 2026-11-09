// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CoverageVector, Vector} from "../script/CoverageVector.sol";
import {DeployBondVault} from "../script/DeployBondVault.s.sol";
import {DeployVerdictVerifier} from "../script/DeployVerdictVerifier.s.sol";
import {CheckpointAnchor} from "../src/CheckpointAnchor.sol";
import {KeelsonBondVault} from "../src/KeelsonBondVault.sol";
import {KeelsonReserve} from "../src/KeelsonReserve.sol";
import {VerdictVerifier} from "../src/VerdictVerifier.sol";
import {IAutomataDcapAttestation} from "../src/interfaces/IAutomataDcapAttestation.sol";
import {IERC8004Identity} from "../src/interfaces/IERC8004Identity.sol";
import {IKeelsonBondVault} from "../src/interfaces/IKeelsonBondVault.sol";
import {INitroValidator} from "../src/interfaces/INitroValidator.sol";
import {IPYUSD} from "../src/interfaces/IPYUSD.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {ForkTest} from "./utils/Fork.sol";
import {VerdictSigners} from "./utils/VerdictSigners.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The amber and green flows on a fork of Arbitrum One, where nothing of Keelson is deployed: verifier, anchor,
/// vault and reserve are deployed on the fork over One's PYUSD and ERC-8004 Identity, and the fork-only signers stand in
/// for the legs (whose attestations bind Arbitrum Sepolia). The passkey assertion is the live WebAuthn one. Only gas is
/// recorded here; behaviour is tested on Arbitrum Sepolia.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract SlashArbOneForkTest is ForkTest, VerdictSigners {
    using stdJson for string;

    string internal constant ORIGIN = "log.keelson.finance/alibi/2026-1";

    KeelsonBondVault internal vault;
    KeelsonReserve internal reserve;
    CheckpointAnchor internal anchor;
    IPYUSD internal pyusd;
    uint256 internal agentId;
    uint256 internal operatorKey;
    address internal merchant = makeAddr("merchant");
    bytes32 internal root = keccak256("one checkpoint");
    uint64 internal constant SIZE = 54;

    function setUp() public {
        _forkAll();
        _select(42161);
        string memory json = _json();
        pyusd = IPYUSD(json.readAddress(".external.pyusd"));
        DeployBondVault script = new DeployBondVault();
        AccessManager manager = new AccessManager(address(this));
        // No legs attest for Arbitrum One yet: any deployed contract satisfies the attestation verifiers' code check,
        // and the fork-only signers are written into the verifier directly.
        address dcap = json.readAddress(".external.automataDcapAttestation");
        VerdictVerifier verifier = new VerdictVerifier(
            address(manager),
            address(this),
            bytes32(0),
            _forkMeasurements(),
            IAutomataDcapAttestation(dcap),
            INitroValidator(dcap)
        );
        anchor = new CheckpointAnchor(verifier);
        address vaultAddress = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        reserve = new KeelsonReserve(
            IERC20(address(pyusd)),
            verifier,
            anchor,
            IKeelsonBondVault(vaultAddress),
            keccak256(bytes(ORIGIN)),
            address(manager),
            10 minutes,
            1 days,
            1 hours,
            1_000e6
        );
        (uint48 window, uint208 capacity) = script.rateLimit();
        vault = new KeelsonBondVault(
            pyusd,
            verifier,
            anchor,
            IERC8004Identity(json.readAddress(".external.erc8004Identity")),
            address(reserve),
            keccak256(bytes(ORIGIN)),
            sha256("keelson.finance"),
            address(manager),
            script.params(),
            window,
            capacity
        );
        assertEq(address(vault), vaultAddress);
        _installVerdictSigners(verifier);

        address operator;
        (operator, operatorKey) = makeAddrAndKey("one operator");
        vm.prank(operator);
        agentId = IERC8004Identity(json.readAddress(".external.erc8004Identity")).register();
        (address funder, uint256 funderKey) = makeAddrAndKey("one funder");
        _fundFromHolder(funder, 200e6);
        bytes memory sig = _signReceiveWithAuthorization(
            funderKey, address(vault), 200e6, 0, type(uint256).max, keccak256(abi.encode(agentId, bytes32("one")))
        );
        vault.depositWithAuthorization(agentId, funder, 200e6, 0, type(uint256).max, "one", sig);
        (address treasury,) = makeAddrAndKey("one treasury");
        _fundFromHolder(treasury, 100e6);
        vm.startPrank(treasury);
        pyusd.approve(address(reserve), 100e6);
        reserve.deposit(100e6, treasury);
        vm.stopPrank();

        bytes memory note = bytes.concat(
            bytes(ORIGIN), "\n", bytes(Strings.toString(SIZE)), "\n", bytes(Base64.encode(abi.encode(root))), "\n\n"
        );
        bytes32 digest = verifier.hashTypedData(
            KeelsonTypes.hash(
                KeelsonTypes.Checkpoint({origin: keccak256(bytes(ORIGIN)), treeSize: SIZE, rootHash: root})
            )
        );
        anchor.anchor(keccak256(bytes(ORIGIN)), SIZE, root, new bytes32[](0), _sign(digest), note);
    }

    function _sign(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(tdxKey, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(nitroKey, digest);
        return abi.encodePacked(r1, s1, v1, r2, s2, v2);
    }

    /// @dev The live WebAuthn coverage, countersigned on the fork for the One agent.
    function _lock(bytes32 coverageId) internal returns (KeelsonTypes.Coverage memory c) {
        Vector memory v = CoverageVector.read(
            vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/coverage-2of2-webauthn.json")), merchant, 600
        );
        v.countersign.requestId = coverageId;
        v.countersign.agentId = agentId;
        vm.warp(v.countersign.issuedAt);
        c = v.coverage;
        c.coverageId = coverageId;
        c.agentId = agentId;
        bytes32 csDigest = vault.verifier().hashTypedData(KeelsonTypes.hash(v.countersign));
        (uint8 sv, bytes32 r, bytes32 s) =
            vm.sign(operatorKey, keccak256(abi.encodePacked("\x19\x01", vault.domainSeparator(), KeelsonTypes.hash(c))));
        vault.lockCoverage(
            c, v.countersign, v.hSd, v.assertion, v.qx, v.qy, abi.encodePacked(r, s, sv), _sign(csDigest)
        );
    }

    function _verdict(bytes32 coverageId, uint96 amount, uint8 liable, string memory dispute)
        internal
        view
        returns (KeelsonTypes.Verdict memory)
    {
        return KeelsonTypes.Verdict({
            disputeId: keccak256(abi.encode(dispute)),
            coverageId: coverageId,
            agentId: agentId,
            payee: merchant,
            amount: amount,
            ruleId: liable == 1 ? 61 : 60,
            liable: liable,
            fieldId: 9,
            evidenceHash: keccak256(abi.encode("evidence", dispute)),
            inputsHash: keccak256(abi.encode("inputs", dispute)),
            policySetHash: bytes32(0),
            checkpointRoot: root,
            issuedAt: uint40(vm.getBlockTimestamp()),
            deadline: uint40(vm.getBlockTimestamp() + 1 hours)
        });
    }

    function test_amberAndGreenGasOnArbitrumOne() public {
        _lock("one/a");
        KeelsonTypes.Verdict memory amber = _verdict("one/a", 50e6, 1, "one/amber");
        bytes memory sigs = _sign2of2(amber);
        vault.slash(amber, SIZE, sigs);
        emit log_named_uint("slash instant on Arbitrum One, transaction", vm.lastCallGas().gasTotalUsed);
        assertEq(pyusd.balanceOf(merchant), 50e6);

        KeelsonTypes.Verdict memory green = _verdict("one/a", 30e6, 2, "one/green");
        sigs = _sign2of2(green);
        reserve.payWarranty(green, SIZE, sigs);
        emit log_named_uint("payWarranty on Arbitrum One, transaction", vm.lastCallGas().gasTotalUsed);
        assertEq(pyusd.balanceOf(merchant), 80e6);
        amber = _verdict("one/a", 10e6, 1, "one/amber-degraded");
        sigs = _signDegraded(amber);
        vault.slash(amber, SIZE, sigs);
        emit log_named_uint("slash queued on Arbitrum One, transaction", vm.lastCallGas().gasTotalUsed);
        vm.warp(vault.queuedSlashes(amber.disputeId).readyAt);
        vault.executeSlash(amber.disputeId);
        emit log_named_uint("executeSlash on Arbitrum One, transaction", vm.lastCallGas().gasTotalUsed);
        assertEq(pyusd.balanceOf(merchant), 90e6);
    }
}
