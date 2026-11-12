// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CoverageVector, Vector} from "../../script/CoverageVector.sol";
import {IVerdictVerifier} from "../../src/interfaces/IVerdictVerifier.sol";
import {SlashBase} from "../utils/SlashBase.sol";
import {KeelsonHandler} from "./KeelsonHandler.sol";
import {MedusaFork} from "./MedusaKeelson.sol";
import {Properties} from "./Properties.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The vault's and the reserve's safety properties under random sequences of every action that moves their
/// funds, on a fork of Arbitrum Sepolia with real PYUSD, the real Paxos freeze and pause, the live coverage vectors and
/// verdicts signed by the fork-only signers.
/// forge-config: default.evm_version = "osaka"
/// forge-config: default.invariant.runs = 8
/// forge-config: default.invariant.depth = 50
/// forge-config: default.invariant.fail_on_revert = false
/// forge-config: ci.evm_version = "osaka"
/// forge-config: ci.invariant.runs = 256
/// forge-config: ci.invariant.depth = 100
/// forge-config: ci.invariant.fail_on_revert = false
contract KeelsonInvariantForkTest is SlashBase, Properties {
    using stdJson for string;

    /// @dev `ci.invariant.runs` above.
    uint256 internal constant CI_RUNS = 256;
    /// @dev Real PYUSD from the pinned holder: a top-up for each funder and the reserve's first stake.
    uint256 internal constant TOP_UP = 1_000e6;
    uint256 internal constant STAKE = 1_000e6;

    KeelsonHandler internal h;

    function setUp() public override {
        super.setUp();
        uint256[] memory funderKeys = new uint256[](3);
        for (uint256 i; i < 3; ++i) {
            address funder;
            (funder, funderKeys[i]) = _funder(i);
            _fundFromHolder(funder, TOP_UP);
            _deposit(i, TOP_UP / 2, bytes32(100 + i));
        }
        address staker = makeAddr("reserve staker");
        _fundFromHolder(staker, STAKE);
        vm.startPrank(staker);
        pyusd.approve(address(reserve), STAKE);
        reserve.deposit(STAKE, staker);
        vm.stopPrank();

        Vector[] memory vectors = new Vector[](3);
        vectors[0] = _vector(WEBAUTHN);
        vectors[1] = _vector(PAYMENT);
        vectors[2] = _vector(DEGRADED);
        h = new KeelsonHandler(
            vault,
            pyusd,
            agentId,
            operatorKey,
            funderKeys,
            vectors,
            KeelsonHandler.Config({
                reserve: reserve,
                verifier: vault.verifier(),
                tdxKey: tdxKey,
                nitroKey: nitroKey,
                merchantKey: merchantKey,
                treeSize: treeSize,
                checkpointRoot: checkpointRoot,
                guardian: _json().readAddress(".contracts.GuardianSafe"),
                assetProtector: _json().readAddress(".external.pyusdAssetProtector"),
                recordLogs: true
            })
        );
        targetContract(address(h));
        targetSelector(StdInvariant.FuzzSelector({addr: address(h), selectors: h.selectors()}));
        // A fixed caller: every new sender of a forked test is an account fetched over RPC.
        targetSender(makeAddr("relayer"));
    }

    function handler() internal view override returns (KeelsonHandler) {
        return h;
    }

    function invariant_conservation() public view {
        assertConservation();
    }

    function invariant_settledUnique() public view {
        assertSettledUnique();
    }

    function invariant_slashWithinCoverage() public view {
        assertSlashWithinCoverage();
    }

    function invariant_noUnsignedSlash() public view {
        assertNoUnsignedSlash();
    }

    function invariant_noEarlyWithdrawal() public view {
        assertNoEarlyWithdrawal();
    }

    function invariant_withdrawalRecipient() public view {
        assertWithdrawalRecipient();
    }

    function invariant_payeeDelta() public view {
        assertPayeeDelta();
    }

    function invariant_outflowsEntitled() public view {
        assertOutflowsEntitled();
    }

    function invariant_slashedDigest() public view {
        assertSlashedDigest();
    }

    function invariant_liable() public view {
        assertLiable();
    }

    function invariant_degradedTdxOnly() public view {
        assertDegradedTdxOnly();
    }

    function invariant_degradedQueued() public view {
        assertDegradedQueued();
    }

    /// @notice A suite where nothing happens proves nothing: across the `ci` campaign, each action that moves funds must
    /// succeed in at least 1% of its calls. Each run starts from the same snapshot, so the totals are carried between
    /// runs in the process environment, which the snapshot does not restore, and checked after the last run. The
    /// default profile's few runs are too small a sample; `test_HandlerReachesEveryAction` covers it.
    function afterInvariant() public {
        bytes4[8] memory actions = [
            h.slash.selector,
            h.executeSlash.selector,
            h.vetoSlash.selector,
            h.claim.selector,
            h.payWarranty.selector,
            h.release.selector,
            h.complete.selector,
            h.freeze.selector
        ];
        uint256 run = _carry("KEELSON_INVARIANT_RUNS", 1);
        bool last =
            keccak256(bytes(vm.envOr("FOUNDRY_PROFILE", string("default")))) == keccak256("ci") && run == CI_RUNS;
        for (uint256 i; i < actions.length; ++i) {
            string memory key = vm.toString(abi.encodePacked(actions[i]));
            uint256 calls = _carry(string.concat("KEELSON_INVARIANT_CALLS_", key), h.calls(actions[i]));
            uint256 ok = _carry(string.concat("KEELSON_INVARIANT_OK_", key), h.ok(actions[i]));
            if (!last) continue;
            emit log_named_string(key, string.concat(vm.toString(ok), " / ", vm.toString(calls)));
            assertGe(ok * 100, calls, string.concat("action below 1% success: ", key));
        }
    }

    /// @notice A deterministic 2,000-call drive (20 runs of 100 calls, each from the setup snapshot, as the invariant
    /// runner does) reaches every action, each succeeding in at least 1% of its calls, with every property holding after
    /// each run.
    function test_HandlerReachesEveryAction() public {
        bytes4[] memory actions = h.selectors();
        uint256[] memory calls = new uint256[](actions.length);
        uint256[] memory ok = new uint256[](actions.length);
        address relayer = makeAddr("relayer");
        for (uint256 run; run < 20; ++run) {
            uint256 snapshot = vm.snapshotState();
            for (uint256 k; k < 100; ++k) {
                uint256 seed = uint256(keccak256(abi.encode("drive", run, k)));
                vm.prank(relayer);
                (bool success,) = address(h).call(_calldata(actions[seed % actions.length], seed >> 8));
                assertTrue(success, "handler actions never revert");
            }
            _assertAll();
            for (uint256 i; i < actions.length; ++i) {
                calls[i] += h.calls(actions[i]);
                ok[i] += h.ok(actions[i]);
            }
            vm.revertToState(snapshot);
        }
        for (uint256 i; i < actions.length; ++i) {
            string memory name = vm.toString(abi.encodePacked(actions[i]));
            emit log_named_string(name, string.concat(vm.toString(ok[i]), " / ", vm.toString(calls[i])));
            assertGt(calls[i], 0, name);
            assertGe(ok[i] * 100, calls[i], name);
        }
    }

    function _assertAll() internal view {
        assertConservation();
        assertSettledUnique();
        assertSlashWithinCoverage();
        assertNoUnsignedSlash();
        assertNoEarlyWithdrawal();
        assertWithdrawalRecipient();
        assertPayeeDelta();
        assertOutflowsEntitled();
        assertSlashedDigest();
        assertLiable();
        assertDegradedTdxOnly();
        assertDegradedQueued();
    }

    /// @notice Medusa cannot read files or the environment, so its harness carries the registry, the measurements and the
    /// vectors as constants; they must equal the files these tests read.
    function test_MedusaConstantsMatchRegistry() public {
        string memory json = _json();
        assertEq(MedusaFork.FORK_BLOCK, FORK_BLOCK, "fork block");
        uint256 active = vm.activeFork();
        vm.createSelectFork(vm.envString(json.readString(".rpcEnv")), FORK_BLOCK);
        assertEq(MedusaFork.FORK_TIMESTAMP, vm.getBlockTimestamp(), "fork timestamp");
        vm.selectFork(active);
        assertEq(MedusaFork.CHAIN_ID, json.readUint(".chainId"), "chain id");
        assertEq(MedusaFork.PYUSD, json.readAddress(".external.pyusd"), "pyusd");
        assertEq(MedusaFork.PYUSD_HOLDER, json.readAddress(".external.pyusdHolder"), "holder");
        assertEq(MedusaFork.ASSET_PROTECTOR, json.readAddress(".external.pyusdAssetProtector"), "asset protector");
        assertEq(MedusaFork.IDENTITY, json.readAddress(".external.erc8004Identity"), "identity");
        assertEq(MedusaFork.PROPOSER, json.readAddress(".governance.proposer"), "proposer");
        assertEq(MedusaFork.AUTHORITY, json.readAddress(".contracts.AccessManager"), "access manager");
        assertEq(MedusaFork.TIMELOCK, json.readAddress(".contracts.TimelockController"), "timelock");
        assertEq(MedusaFork.GUARDIAN, json.readAddress(".contracts.GuardianSafe"), "guardian");
        assertEq(MedusaFork.DEPLOYER, json.readAddress(".contracts.KeelsonDeployer"), "deployer");
        assertEq(MedusaFork.VERIFIER, json.readAddress(".contracts.VerdictVerifier"), "verifier");
        assertEq(MedusaFork.VAULT, json.readAddress(".contracts.KeelsonBondVault"), "vault");
        assertEq(MedusaFork.RESERVE, json.readAddress(".contracts.KeelsonReserve"), "reserve");
        assertEq(MedusaFork.DEMO_OPERATOR, json.readAddress(".demo.operator"), "demo operator");
        assertEq(MedusaFork.MERCHANT_OF_RECORD, json.readAddress(".demo.merchant"), "demo merchant");
        assertEq(MedusaFork.AGENT_ID, json.readUint(".demo.agentId"), "agent id");
        assertEq(address(vault), MedusaFork.VAULT, "vault address on the fork");
        assertEq(address(reserve), MedusaFork.RESERVE, "reserve address on the fork");
        assertEq(MedusaFork.vaultArgs(), deployScript.constructorArgs(), "vault constructor args");
        assertEq(MedusaFork.reserveArgs(), reserveScript.constructorArgs(), "reserve constructor args");
        assertEq(MedusaFork.vaultArgs(), json.readBytes(".constructorArgs.KeelsonBondVault"), "registry vault args");
        // The deployed reserve's constructor also took an unstake window, its eighth argument.
        bytes memory deployed = json.readBytes(".constructorArgs.KeelsonReserve");
        bytes memory current = new bytes(deployed.length - 32);
        for (uint256 i; i < current.length; ++i) {
            current[i] = deployed[i < 7 * 32 ? i : i + 32];
        }
        assertEq(MedusaFork.reserveArgs(), current, "registry reserve args");

        IVerdictVerifier vv = IVerdictVerifier(MedusaFork.VERIFIER);
        assertTrue(vv.allowedMeasurement(MedusaFork.TDX_MEASUREMENT), "tdx measurement allowed at the fork");
        assertTrue(vv.allowedMeasurement(MedusaFork.NITRO_MEASUREMENT), "nitro measurement allowed at the fork");

        string[3] memory names = [WEBAUTHN, PAYMENT, DEGRADED];
        for (uint256 i; i < 3; ++i) {
            string memory file = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/", names[i], ".json"));
            Vector memory expected =
                CoverageVector.read(file, json.readAddress(".demo.merchant"), vault.params().disputeWindow);
            assertEq(keccak256(abi.encode(MedusaFork.vector(i))), keccak256(abi.encode(expected)), names[i]);
        }
    }

    function _calldata(bytes4 action, uint256 seed) internal view returns (bytes memory) {
        bool flagA = (seed >> 200) % 2 == 0;
        bool flagB = (seed >> 201) % 4 != 0;
        if (action == h.deposit.selector) return abi.encodeWithSelector(action, seed, seed >> 64, seed >> 128);
        if (action == h.slash.selector) return abi.encodeWithSelector(action, seed, flagA, flagB);
        if (action == h.payWarranty.selector) return abi.encodeWithSelector(action, seed, (seed >> 202) % 8 == 0);
        if (
            action == h.pauseToken.selector || action == h.unpauseToken.selector || action == h.pauseVault.selector
                || action == h.unpauseVault.selector
        ) return abi.encodeWithSelector(action);
        return abi.encodeWithSelector(action, seed);
    }

    function _carry(string memory key, uint256 add) internal returns (uint256 total) {
        total = vm.envOr(key, uint256(0)) + add;
        vm.setEnv(key, vm.toString(total));
    }
}
