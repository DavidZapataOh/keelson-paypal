// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonBondVault} from "../src/KeelsonBondVault.sol";
import {IKeelsonBondVault} from "../src/interfaces/IKeelsonBondVault.sol";
import {IPYUSD} from "../src/interfaces/IPYUSD.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {CoverageVector, Vector} from "./CoverageVector.sol";
import {KeelsonDeploy} from "./KeelsonDeploy.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";

/// @notice Locks a live coverage in the vault deployed under `vaultName`: the funders' faucet PYUSD is deposited for the
/// demo agent by EIP-3009 when its bond is short, then the coverage of a vector captured minutes before (its countersign
/// lives 15 minutes) is locked with the demo operator's signature. The deployer EOA submits, as the relayer would.
/// @dev `forge script script/LockCoverageLive.s.sol --sig "run(string,string)" KeelsonBondVaultPreview
/// test/vectors/coverage-live.json --rpc-url arbitrum_sepolia --account keelson-deployer --broadcast`; reads
/// `KEELSON_FUNDER_KEYS` and `KEELSON_OPERATOR_KEY`.
contract LockCoverageLive is KeelsonDeploy {
    using stdJson for string;

    bytes32 internal constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function run(string calldata vaultName, string calldata vectorPath) external {
        KeelsonBondVault vault = KeelsonBondVault(predict(vaultName));
        string memory registry = _registry();
        Vector memory v = CoverageVector.read(
            vm.readFile(string.concat(vm.projectRoot(), "/", vectorPath)),
            registry.readAddress(".demo.merchant"),
            vault.params().disputeWindow
        );
        require(v.vault == address(vault), "the vector was captured for another vault");
        uint256 operatorKey = vm.envUint("KEELSON_OPERATOR_KEY");
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(
            operatorKey, keccak256(abi.encodePacked("\x19\x01", vault.domainSeparator(), KeelsonTypes.hash(v.coverage)))
        );

        vm.startBroadcast(_owner());
        if (vault.bonds(v.coverage.agentId).free < uint256(v.coverage.amount) + v.coverage.premium) {
            _depositFunders(vault, v.coverage.agentId);
        }
        vault.lockCoverage(
            v.coverage, v.countersign, v.hSd, v.assertion, v.qx, v.qy, abi.encodePacked(r, s, sv), v.countersigs
        );
        vm.stopBroadcast();

        require(vault.coverages(v.coverage.coverageId).status == IKeelsonBondVault.Status.Active, "not locked");
        console.log("coverageId");
        console.logBytes32(v.coverage.coverageId);
    }

    function _depositFunders(KeelsonBondVault vault, uint256 agentId) internal {
        IPYUSD pyusd = vault.pyusd();
        bytes32 domain = pyusd.DOMAIN_SEPARATOR();
        string[] memory keys = vm.split(vm.envString("KEELSON_FUNDER_KEYS"), ",");
        for (uint256 i; i < keys.length; ++i) {
            uint256 pk = vm.parseUint(keys[i]);
            address from = vm.addr(pk);
            uint256 amount = pyusd.balanceOf(from);
            if (amount == 0) continue;
            bytes32 salt = keccak256(abi.encode("keelson/live-deposit", from, vm.getBlockTimestamp()));
            bytes32 structHash = keccak256(
                abi.encode(
                    RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                    from,
                    address(vault),
                    amount,
                    0,
                    type(uint256).max,
                    keccak256(abi.encode(agentId, salt))
                )
            );
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
            vault.depositWithAuthorization(agentId, from, amount, 0, type(uint256).max, salt, abi.encodePacked(r, s, v));
        }
    }
}
