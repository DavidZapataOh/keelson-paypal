// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployBondVault} from "../../script/DeployBondVault.s.sol";
import {KeelsonBondVault} from "../../src/KeelsonBondVault.sol";
import {IKeelsonBondVault} from "../../src/interfaces/IKeelsonBondVault.sol";
import {KeelsonTypes} from "../../src/libraries/KeelsonTypes.sol";
import {PasskeyAssertion} from "../../src/libraries/PasskeyAssertion.sol";
import {ForkTest} from "./Fork.sol";
import {IPyusd} from "./IPyusd.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The vault deployed by its script on a fork of Arbitrum Sepolia, after the demo operator was registered in the
/// ERC-8004 Identity registry, with the real `VerdictVerifier` (both legs' signers registered), `CheckpointAnchor`,
/// PYUSD and the funders' faucet balances.
abstract contract VaultBase is ForkTest {
    using stdJson for string;

    uint256 internal constant FORK_BLOCK = 327_231_200;
    string internal constant VAULT = "KeelsonBondVaultPreview";

    DeployBondVault internal deployScript;
    KeelsonBondVault internal vault;
    IPyusd internal pyusd;
    uint256 internal agentId;
    address internal operator;
    uint256 internal operatorKey;
    uint256 internal saltCounter;

    function setUp() public virtual {
        vm.createSelectFork(vm.envString("ARBITRUM_SEPOLIA_RPC_URL"), FORK_BLOCK);
        pyusd = _pyusd();
        agentId = _demoAgentId();
        (operator, operatorKey) = _operator();
        assertEq(_identity().ownerOf(agentId), operator, "demo agent owner");

        deployScript = new DeployBondVault();
        vault = deployScript.run(VAULT);
        vm.warp(vm.getBlockTimestamp() + _timelock().getMinDelay());
        deployScript.wire(VAULT);
    }

    function _timelock() internal view returns (TimelockController) {
        return TimelockController(payable(_json().readAddress(".contracts.TimelockController")));
    }

    /// @dev Scheduled by the proposer (the deployer EOA) and executed once the delay passed.
    function _viaTimelock(address to, bytes memory data) internal {
        TimelockController timelock = _timelock();
        bytes32 salt = bytes32(++saltCounter);
        uint256 delay = timelock.getMinDelay();
        vm.prank(_json().readAddress(".governance.proposer"));
        timelock.schedule(to, 0, data, bytes32(0), salt, delay);
        vm.warp(vm.getBlockTimestamp() + delay);
        timelock.execute(to, 0, data, bytes32(0), salt);
    }

    /// @dev A funder's real faucet PYUSD, deposited for `agentId` through EIP-3009.
    function _deposit(uint256 funder, uint256 amount, bytes32 salt) internal {
        (address from, uint256 pk) = _funder(funder);
        bytes32 nonce = keccak256(abi.encode(agentId, salt));
        bytes memory sig = _signReceiveWithAuthorization(pk, address(vault), amount, 0, type(uint256).max, nonce);
        vault.depositWithAuthorization(agentId, from, amount, 0, type(uint256).max, salt, sig);
    }

    function _signVault(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", vault.domainSeparator(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    /// @dev Tests run each call as its own transaction (`isolate`), so the last call's gas is the transaction's;
    /// execution is that less the 21,000 base and the EIP-2028 calldata cost.
    function _executionGas(bytes memory callData) internal view returns (uint256) {
        uint256 calldataGas;
        for (uint256 i; i < callData.length; ++i) {
            calldataGas += callData[i] == 0 ? 4 : 16;
        }
        return vm.lastCallGas().gasTotalUsed - 21_000 - calldataGas;
    }

    function _bond() internal view returns (IKeelsonBondVault.Bond memory) {
        return vault.bonds(agentId);
    }

    /// @dev Every faucet PYUSD the three funders hold, deposited for the demo agent.
    function _depositAll() internal returns (uint256 total) {
        for (uint256 i; i < 3; ++i) {
            (address from,) = _funder(i);
            uint256 balance = pyusd.balanceOf(from);
            _deposit(i, balance, bytes32(i));
            total += balance;
        }
    }
}

/// @notice A coverage captured live: the demo mandate signed with a real passkey in Chromium, countersigned by the live
/// legs (`vectors/coverage-*.json`), and the `Coverage` the demo operator signs for it.
struct Vector {
    KeelsonTypes.Coverage coverage;
    KeelsonTypes.Countersign countersign;
    bytes32 hSd;
    PasskeyAssertion.Assertion assertion;
    bytes32 qx;
    bytes32 qy;
    bytes countersigs;
    bytes tdx;
    bytes nitro;
    bytes32 digest;
    bytes32 userKeyHash;
    bool degraded;
}

abstract contract LockBase is VaultBase {
    using stdJson for string;

    string internal constant WEBAUTHN = "coverage-2of2-webauthn";
    string internal constant PAYMENT = "coverage-2of2-payment";
    string internal constant DEGRADED = "coverage-degraded";
    /// @dev The premium the risk model will set; 1% for the tests.
    uint256 internal constant PREMIUM_BPS = 100;

    function _vector(string memory name) internal view returns (Vector memory v) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/", name, ".json"));
        assertEq(json.readUint(".chainId"), 421614);
        assertEq(json.readAddress(".vault"), address(vault), "vector vault");
        v.countersign = _countersign(json);
        v.hSd = json.readBytes32(".hSd");
        v.assertion.r = json.readBytes32(".encodedAssertion.r");
        v.assertion.s = json.readBytes32(".encodedAssertion.s");
        v.assertion.challengeIndex = json.readUint(".encodedAssertion.challengeIndex");
        v.assertion.typeIndex = json.readUint(".encodedAssertion.typeIndex");
        v.assertion.authenticatorData = json.readBytes(".encodedAssertion.authenticatorData");
        v.assertion.clientDataJSON = json.readString(".encodedAssertion.clientDataJSON");
        v.qx = json.readBytes32(".qx");
        v.qy = json.readBytes32(".qy");
        v.tdx = json.readBytes(".signatures.tdx");
        v.degraded = keccak256(bytes(json.readString(".mode"))) == keccak256("degraded");
        if (!v.degraded) v.nitro = json.readBytes(".signatures.nitro");
        v.countersigs = bytes.concat(v.tdx, v.nitro);
        v.digest = json.readBytes32(".digest");
        v.userKeyHash = json.readBytes32(".userKeyHash");

        uint96 amount = uint96(v.countersign.amount * 10_000);
        v.coverage = KeelsonTypes.Coverage({
            coverageId: v.countersign.requestId,
            agentId: v.countersign.agentId,
            merchant: _json().readAddress(".demo.merchant"),
            amount: amount,
            premium: uint96(amount * PREMIUM_BPS / 10_000),
            expiresAt: v.countersign.issuedAt + uint40(vault.params().disputeWindow),
            mandateHash: v.countersign.mandateHash,
            amberCommitment: keccak256(abi.encode("amber", v.countersign.requestId))
        });
    }

    function _countersign(string memory json) internal pure returns (KeelsonTypes.Countersign memory c) {
        c.requestId = json.readBytes32(".countersign.requestId");
        c.mandateHash = json.readBytes32(".countersign.mandateHash");
        c.mandateCommitment = json.readBytes32(".countersign.mandateCommitment");
        c.cartHash = json.readBytes32(".countersign.cartHash");
        c.agentId = json.readUint(".countersign.agentId");
        c.merchantId = json.readBytes32(".countersign.merchantId");
        c.amount = uint64(json.readUint(".countersign.amount"));
        c.currency = uint16(json.readUint(".countersign.currency"));
        c.category = uint8(json.readUint(".countersign.category"));
        c.evidenceRoot = json.readBytes32(".countersign.evidenceRoot");
        c.evalHash = json.readBytes32(".countersign.evalHash");
        c.policySetHash = json.readBytes32(".countersign.policySetHash");
        c.decision = uint8(json.readUint(".countersign.decision"));
        c.failedFieldsMask = uint32(json.readUint(".countersign.failedFieldsMask"));
        c.issuedAt = uint40(json.readUint(".countersign.issuedAt"));
        c.expiresAt = uint40(json.readUint(".countersign.expiresAt"));
    }

    function _operatorSig(KeelsonTypes.Coverage memory c) internal view returns (bytes memory) {
        return _signVault(operatorKey, KeelsonTypes.hash(c));
    }

    /// @dev At the countersign's issue time, as the relayer submits it.
    function _lock(Vector memory v) internal {
        _lock(v, _operatorSig(v.coverage));
    }

    function _lock(Vector memory v, bytes memory operatorSig) internal {
        vault.lockCoverage(v.coverage, v.countersign, v.hSd, v.assertion, v.qx, v.qy, operatorSig, v.countersigs);
    }

    function _lockCalldata(Vector memory v, bytes memory operatorSig) internal view returns (bytes memory) {
        return abi.encodeCall(
            vault.lockCoverage, (v.coverage, v.countersign, v.hSd, v.assertion, v.qx, v.qy, operatorSig, v.countersigs)
        );
    }
}
