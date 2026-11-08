// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC8004Identity} from "./interfaces/IERC8004Identity.sol";
import {IERC8004Validation} from "./interfaces/IERC8004Validation.sol";
import {IKeelsonBondVault} from "./interfaces/IKeelsonBondVault.sol";
import {IKeelsonValidationRegistry} from "./interfaces/IKeelsonValidationRegistry.sol";
import {IVerdictVerifier} from "./interfaces/IVerdictVerifier.sol";
import {CoverageOutcome} from "./libraries/CoverageOutcome.sol";
import {KeelsonTypes} from "./libraries/KeelsonTypes.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title KeelsonValidationRegistry
/// @notice An ERC-8004 Validation registry (v2.0.0 reads and events) holding one validation per Alibi, pointing to the
/// official Identity registry. The validator is the `VerdictVerifier`; the request is the `Countersign` both TEE legs
/// signed, and the response is `100` for ALLOW, `0` for DENY, then the coverage's outcome. Ownerless, not upgradeable.
/// @dev Deviation from the ERC: requests are not sent by the agent's owner, nor responses by the validator address.
/// The legs' signatures, checked by the `VerdictVerifier`, prove the response; for an ALLOW, the coverage the vault
/// locked only with the operator's signature over the same request proves the operator asked. So anyone may submit
/// both, and the flow stays gasless. There is no `validationRequest`/`validationResponse` for third parties: a request
/// hash chosen by someone else could take a countersign's digest before it is recorded.
contract KeelsonValidationRegistry is IKeelsonValidationRegistry {
    using CoverageOutcome for IKeelsonBondVault;

    /// @dev The reference's `ValidationStatus` in four slots. Every validation here has a response.
    struct ValidationStatus {
        address validatorAddress;
        uint8 response;
        uint40 lastUpdate;
        uint256 agentId;
        bytes32 responseHash;
        string tag;
    }

    string public constant REQUEST_BASE_URI = "https://api.keelson.finance/v1/validations/";
    uint8 internal constant ALLOW = 1;
    uint8 internal constant DENY = 2;
    uint256 internal constant SIGNATURE_LENGTH = 65;

    IERC8004Identity public immutable identity;
    IVerdictVerifier public immutable verifier;
    IKeelsonBondVault public immutable vault;

    mapping(bytes32 requestHash => ValidationStatus) internal _validations;
    mapping(uint256 agentId => bytes32[]) internal _agentValidations;
    mapping(address validator => bytes32[]) internal _validatorRequests;
    /// @inheritdoc IKeelsonValidationRegistry
    mapping(bytes32 coverageId => bytes32) public requestOf;
    mapping(bytes32 coverageId => bool) public outcomeRecorded;

    constructor(IERC8004Identity identity_, IVerdictVerifier verifier_, IKeelsonBondVault vault_) {
        identity = identity_;
        verifier = verifier_;
        vault = vault_;
    }

    /// @inheritdoc IKeelsonValidationRegistry
    /// @dev A DENY recorded from the TDX signature alone becomes `"2of2"` when both signatures arrive; an ALLOW must
    /// carry the signatures its coverage was locked with.
    function recordCountersign(KeelsonTypes.Countersign calldata c, bytes calldata sigs)
        external
        returns (bytes32 requestHash)
    {
        requestHash = verifier.hashTypedData(KeelsonTypes.hash(c));
        bool degraded = sigs.length == SIGNATURE_LENGTH;
        if (!(sigs.length == 2 * SIGNATURE_LENGTH
                    ? verifier.verify2of2(requestHash, sigs)
                    : degraded && verifier.verifyDegraded(requestHash, sigs))) revert InvalidCountersign();
        string memory tag = degraded ? "degraded" : "2of2";
        ValidationStatus storage s = _validations[requestHash];

        if (s.validatorAddress != address(0)) {
            if (degraded || c.decision != DENY || keccak256(bytes(s.tag)) != keccak256("degraded")) {
                revert ValidationExists();
            }
            _respond(s, requestHash, 0, tag);
            return requestHash;
        }

        uint8 response = 0;
        if (c.decision == ALLOW) {
            IKeelsonBondVault.CoverageState memory cov = vault.coverages(c.requestId);
            if (cov.status == IKeelsonBondVault.Status.None || cov.agentId != c.agentId) revert NotCovered();
            if (cov.degraded != degraded) revert InvalidCountersign();
            if (requestOf[c.requestId] != 0) revert ValidationExists();
            requestOf[c.requestId] = requestHash;
            response = 100;
        } else if (c.decision != DENY) {
            revert InvalidCountersign();
        }

        _validations[requestHash] = ValidationStatus({
            validatorAddress: address(verifier),
            response: response,
            lastUpdate: uint40(block.timestamp),
            agentId: c.agentId,
            responseHash: c.evalHash,
            tag: tag
        });
        _agentValidations[c.agentId].push(requestHash);
        _validatorRequests[address(verifier)].push(requestHash);
        emit ValidationRequest(
            address(verifier), c.agentId, string.concat(REQUEST_BASE_URI, _hex(requestHash)), requestHash
        );
        emit ValidationResponse(address(verifier), c.agentId, requestHash, response, "", c.evalHash, tag);
        if (c.decision == ALLOW) {
            (CoverageOutcome.Outcome outcome,) = vault.outcomeOf(c.requestId);
            if (outcome != CoverageOutcome.Outcome.Open) _recordOutcome(s, c.requestId, requestHash, outcome);
        }
    }

    /// @inheritdoc IKeelsonValidationRegistry
    function recordOutcome(bytes32 coverageId) external {
        bytes32 requestHash = requestOf[coverageId];
        if (requestHash == 0) revert UnknownValidation();
        if (outcomeRecorded[coverageId]) revert OutcomeRecorded();
        (CoverageOutcome.Outcome outcome,) = vault.outcomeOf(coverageId);
        if (outcome == CoverageOutcome.Outcome.Open) revert OutcomeNotFinal();
        _recordOutcome(_validations[requestHash], coverageId, requestHash, outcome);
    }

    /// @inheritdoc IERC8004Validation
    function getIdentityRegistry() external view returns (address) {
        return address(identity);
    }

    /// @inheritdoc IERC8004Validation
    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        )
    {
        ValidationStatus storage s = _validations[requestHash];
        if (s.validatorAddress == address(0)) revert UnknownValidation();
        return (s.validatorAddress, s.agentId, s.response, s.responseHash, s.tag, s.lastUpdate);
    }

    /// @inheritdoc IERC8004Validation
    /// @dev As the reference: an empty validator list or tag matches all; the average truncates.
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 avgResponse)
    {
        bytes32[] storage requestHashes = _agentValidations[agentId];
        bytes32 tagHash = keccak256(bytes(tag));
        uint256 total = 0;
        for (uint256 i; i < requestHashes.length; ++i) {
            ValidationStatus storage s = _validations[requestHashes[i]];
            bool matchValidator = validatorAddresses.length == 0;
            for (uint256 j = 0; !matchValidator && j < validatorAddresses.length; ++j) {
                matchValidator = s.validatorAddress == validatorAddresses[j];
            }
            if (matchValidator && (bytes(tag).length == 0 || keccak256(bytes(s.tag)) == tagHash)) {
                total += s.response;
                ++count;
            }
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        avgResponse = count > 0 ? uint8(total / count) : 0;
    }

    /// @inheritdoc IERC8004Validation
    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return _agentValidations[agentId];
    }

    /// @inheritdoc IERC8004Validation
    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory) {
        return _validatorRequests[validatorAddress];
    }

    /// @inheritdoc IERC8004Validation
    function getVersion() external pure returns (string memory) {
        return "2.0.0";
    }

    function _recordOutcome(
        ValidationStatus storage s,
        bytes32 coverageId,
        bytes32 requestHash,
        CoverageOutcome.Outcome outcome
    ) internal {
        outcomeRecorded[coverageId] = true;
        bool settled = outcome == CoverageOutcome.Outcome.Settled;
        _respond(s, requestHash, settled ? 100 : 0, settled ? "settled" : "slashed");
    }

    function _respond(ValidationStatus storage s, bytes32 requestHash, uint8 response, string memory tag) internal {
        s.response = response;
        s.lastUpdate = uint40(block.timestamp);
        s.tag = tag;
        emit ValidationResponse(s.validatorAddress, s.agentId, requestHash, response, "", s.responseHash, tag);
    }

    function _hex(bytes32 value) internal pure returns (string memory) {
        return Strings.toHexString(uint256(value), 32);
    }
}
