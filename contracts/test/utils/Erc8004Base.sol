// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vector} from "../../script/CoverageVector.sol";
import {DeployErc8004} from "../../script/DeployErc8004.s.sol";
import {KeelsonReputationReporter} from "../../src/KeelsonReputationReporter.sol";
import {KeelsonValidationRegistry} from "../../src/KeelsonValidationRegistry.sol";
import {IERC8004Reputation} from "../../src/interfaces/IERC8004Reputation.sol";
import {KeelsonTypes} from "../../src/libraries/KeelsonTypes.sol";
import {SlashBase} from "./SlashBase.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The validation registry and the reputation reporter deployed by their script next to the vault on a fork of
/// Arbitrum Sepolia, against the official ERC-8004 Identity and Reputation registries.
abstract contract Erc8004Base is SlashBase {
    using stdJson for string;

    uint8 internal constant DENY = 2;

    KeelsonValidationRegistry internal validation;
    KeelsonReputationReporter internal reporter;
    IERC8004Reputation internal reputation;

    function setUp() public virtual override {
        super.setUp();
        // Three coverages of 94 PYUSD plus premiums; the funders' faucet balances alone fall short.
        _fundFromHolder(address(this), 300e6);
        (address funder,) = _funder(0);
        assertTrue(pyusd.transfer(funder, 300e6));
        _deposit(0, 300e6, keccak256("erc8004 top-up"));
        (validation, reporter) = new DeployErc8004().run();
        reputation = IERC8004Reputation(_json().readAddress(".external.erc8004Reputation"));
        assertEq(address(reporter.vault()), address(vault), "reporter vault");
        assertEq(address(validation.vault()), address(vault), "validation vault");
    }

    function _reporters() internal view returns (address[] memory clients) {
        clients = new address[](1);
        clients[0] = address(reporter);
    }

    function _validators() internal view returns (address[] memory validators) {
        validators = new address[](1);
        validators[0] = address(vault.verifier());
    }

    /// @dev Past the coverage's window and grace, then released.
    function _release(Vector memory v) internal {
        vm.warp(vault.coverages(v.coverage.coverageId).releaseAfter + 1);
        vault.releaseCoverage(v.coverage.coverageId);
    }

    /// @dev A countersign signed by the fork-only signers, for decisions the live vectors do not cover.
    function _sign2of2(KeelsonTypes.Countersign memory c) internal view returns (bytes memory) {
        return bytes.concat(_signCountersign(tdxKey, c), _signCountersign(nitroKey, c));
    }

    /// @dev The operator's `ValidationRequest` for a DENY.
    function _operatorRequest(KeelsonTypes.Countersign memory c) internal view returns (bytes memory) {
        bytes32 requestHash = verdictVerifier.hashTypedData(KeelsonTypes.hash(c));
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                validation.domainSeparator(),
                keccak256(abi.encode(validation.VALIDATION_REQUEST_TYPEHASH(), requestHash))
            )
        );
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(operatorKey, digest);
        return abi.encodePacked(r, s, sv);
    }

    function _signCountersign(uint256 pk, KeelsonTypes.Countersign memory c) internal view returns (bytes memory) {
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(pk, verdictVerifier.hashTypedData(KeelsonTypes.hash(c)));
        return abi.encodePacked(r, s, sv);
    }
}
