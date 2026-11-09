// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IKeelsonBondVault} from "../src/interfaces/IKeelsonBondVault.sol";
import {IKeelsonReserve} from "../src/interfaces/IKeelsonReserve.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {ForkTest} from "./utils/Fork.sol";
import {IPyusd} from "./utils/IPyusd.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice One verdict per attribution rule, signed by the live TEE legs against a coverage the deployed vault locked,
/// settled on a fork of Arbitrum Sepolia right after that lock. Nothing is installed on the fork: the signatures pass
/// `VerdictVerifier` because the legs' signers are registered there. Operator verdicts slash the bond, Keelson verdicts
/// are paid by the reserve, and the contracts refuse the others.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract SettlementLiveForkTest is ForkTest {
    using stdJson for string;

    uint8 internal constant OPERATOR = 1;
    uint8 internal constant KEELSON = 2;

    IKeelsonBondVault internal vault;
    IKeelsonReserve internal reserve;
    IPyusd internal pyusd;
    string internal vectors;

    function setUp() public {
        vectors = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/verdicts-live.json"));
        vm.createSelectFork(vm.envString("ARBITRUM_SEPOLIA_RPC_URL"), vectors.readUint(".block"));
        string memory json = _jsonOf(421614);
        vault = IKeelsonBondVault(json.readAddress(".contracts.KeelsonBondVault"));
        reserve = IKeelsonReserve(json.readAddress(".contracts.KeelsonReserve"));
        pyusd = _pyusd();
    }

    function test_everyRuleSettlesOnlyWithThePartyAtFault() public {
        uint64 treeSize = uint64(vectors.readUint(".treeSize"));
        uint256 n;
        uint256 slashed;
        uint256 warranted;
        for (;; ++n) {
            string memory key = string.concat(".verdicts[", vm.toString(n), "]");
            if (!vm.keyExistsJson(vectors, key)) break;
            KeelsonTypes.Verdict memory v =
                abi.decode(vectors.readBytes(string.concat(key, ".verdict")), (KeelsonTypes.Verdict));
            bytes memory sigs = vectors.readBytes(string.concat(key, ".signatures"));
            assertEq(v.ruleId, vectors.readUint(string.concat(key, ".rule")), "rule");
            assertEq(v.liable, vectors.readUint(string.concat(key, ".liable")), "liable");
            assertEq(v.coverageId, vectors.readBytes32(".coverageId"), "coverage");
            uint256 before = pyusd.balanceOf(v.payee);

            if (v.liable == OPERATOR) {
                vm.expectEmit(address(vault));
                emit IKeelsonBondVault.Slashed(
                    v.disputeId,
                    v.coverageId,
                    v.agentId,
                    v.payee,
                    v.amount,
                    v.fieldId,
                    v.evidenceHash,
                    vectors.readBytes32(string.concat(key, ".digest"))
                );
                vault.slash(v, treeSize, sigs);
                assertEq(pyusd.balanceOf(v.payee), before + v.amount, "slash paid");
                vm.expectRevert(IKeelsonReserve.NotKeelsonLiable.selector);
                reserve.payWarranty(v, treeSize, sigs);
                ++slashed;
            } else if (v.liable == KEELSON) {
                vm.expectEmit(address(reserve));
                emit IKeelsonReserve.WarrantyPaid(
                    v.disputeId, v.coverageId, v.payee, v.amount, vectors.readBytes32(string.concat(key, ".digest"))
                );
                reserve.payWarranty(v, treeSize, sigs);
                assertEq(pyusd.balanceOf(v.payee), before + v.amount, "warranty paid");
                vm.expectRevert(IKeelsonBondVault.NotOperatorLiable.selector);
                vault.slash(v, treeSize, sigs);
                ++warranted;
            } else {
                vm.expectRevert(IKeelsonBondVault.NotOperatorLiable.selector);
                vault.slash(v, treeSize, sigs);
                vm.expectRevert(IKeelsonReserve.NotKeelsonLiable.selector);
                reserve.payWarranty(v, treeSize, sigs);
            }
        }
        assertEq(n, 15, "one verdict per rule");
        assertEq(slashed, 3, "R00, R31, R61");
        assertEq(warranted, 2, "R30, R60");
    }
}
