// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {VerifierBase} from "./utils/VerifierBase.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The struct hashes match `packages/core/test/vectors/eip712.json`, which the TypeScript (viem) and Rust
/// (alloy) encoders are tested against, and the verifier's digests use its own domain.
contract KeelsonTypesTest is VerifierBase {
    using stdJson for string;

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    string internal vectors;

    function setUp() public override {
        super.setUp();
        vectors = vm.readFile(string.concat(vm.projectRoot(), "/../packages/core/test/vectors/eip712.json"));
    }

    function _digest(string memory item, bytes32 structHash) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("Keelson"),
                keccak256("1"),
                vectors.readUint(string.concat(item, ".input.chainId")),
                vectors.readAddress(string.concat(item, ".input.verifyingContract"))
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _countersign(string memory m) internal view returns (KeelsonTypes.Countersign memory c) {
        c.requestId = vectors.readBytes32(string.concat(m, ".requestId"));
        c.mandateHash = vectors.readBytes32(string.concat(m, ".mandateHash"));
        c.mandateCommitment = vectors.readBytes32(string.concat(m, ".mandateCommitment"));
        c.cartHash = vectors.readBytes32(string.concat(m, ".cartHash"));
        c.agentId = vectors.readUint(string.concat(m, ".agentId"));
        c.merchantId = vectors.readBytes32(string.concat(m, ".merchantId"));
        c.amount = uint64(vectors.readUint(string.concat(m, ".amount")));
        c.currency = uint16(vectors.readUint(string.concat(m, ".currency")));
        c.category = uint8(vectors.readUint(string.concat(m, ".category")));
        c.evidenceRoot = vectors.readBytes32(string.concat(m, ".evidenceRoot"));
        c.evalHash = vectors.readBytes32(string.concat(m, ".evalHash"));
        c.policySetHash = vectors.readBytes32(string.concat(m, ".policySetHash"));
        c.decision = uint8(vectors.readUint(string.concat(m, ".decision")));
        c.failedFieldsMask = uint32(vectors.readUint(string.concat(m, ".failedFieldsMask")));
        c.issuedAt = uint40(vectors.readUint(string.concat(m, ".issuedAt")));
        c.expiresAt = uint40(vectors.readUint(string.concat(m, ".expiresAt")));
    }

    function _verdict(string memory m) internal view returns (KeelsonTypes.Verdict memory v) {
        v.disputeId = vectors.readBytes32(string.concat(m, ".disputeId"));
        v.coverageId = vectors.readBytes32(string.concat(m, ".coverageId"));
        v.agentId = vectors.readUint(string.concat(m, ".agentId"));
        v.payee = vectors.readAddress(string.concat(m, ".payee"));
        v.amount = uint96(vectors.readUint(string.concat(m, ".amount")));
        v.ruleId = uint8(vectors.readUint(string.concat(m, ".ruleId")));
        v.liable = uint8(vectors.readUint(string.concat(m, ".liable")));
        v.fieldId = uint8(vectors.readUint(string.concat(m, ".fieldId")));
        v.evidenceHash = vectors.readBytes32(string.concat(m, ".evidenceHash"));
        v.inputsHash = vectors.readBytes32(string.concat(m, ".inputsHash"));
        v.policySetHash = vectors.readBytes32(string.concat(m, ".policySetHash"));
        v.checkpointRoot = vectors.readBytes32(string.concat(m, ".checkpointRoot"));
        v.issuedAt = uint40(vectors.readUint(string.concat(m, ".issuedAt")));
        v.deadline = uint40(vectors.readUint(string.concat(m, ".deadline")));
    }

    function _checkpoint(string memory m) internal view returns (KeelsonTypes.Checkpoint memory c) {
        c.origin = vectors.readBytes32(string.concat(m, ".origin"));
        c.treeSize = uint64(vectors.readUint(string.concat(m, ".treeSize")));
        c.rootHash = vectors.readBytes32(string.concat(m, ".rootHash"));
    }

    function _coverage(string memory m) internal view returns (KeelsonTypes.Coverage memory c) {
        c.coverageId = vectors.readBytes32(string.concat(m, ".coverageId"));
        c.agentId = vectors.readUint(string.concat(m, ".agentId"));
        c.merchant = vectors.readAddress(string.concat(m, ".merchant"));
        c.amount = uint96(vectors.readUint(string.concat(m, ".amount")));
        c.premium = uint96(vectors.readUint(string.concat(m, ".premium")));
        c.expiresAt = uint40(vectors.readUint(string.concat(m, ".expiresAt")));
        c.mandateHash = vectors.readBytes32(string.concat(m, ".mandateHash"));
        c.amberCommitment = vectors.readBytes32(string.concat(m, ".amberCommitment"));
        c.userKeyHash = vectors.readBytes32(string.concat(m, ".userKeyHash"));
    }

    function _coverageBatch(string memory m) internal view returns (KeelsonTypes.CoverageBatch memory b) {
        b.agentId = vectors.readUint(string.concat(m, ".agentId"));
        b.root = vectors.readBytes32(string.concat(m, ".root"));
        b.total = uint128(vectors.readUint(string.concat(m, ".total")));
        b.premium = uint96(vectors.readUint(string.concat(m, ".premium")));
        b.expiresAt = uint40(vectors.readUint(string.concat(m, ".expiresAt")));
        b.checkpointRoot = vectors.readBytes32(string.concat(m, ".checkpointRoot"));
        b.treeSize = uint64(vectors.readUint(string.concat(m, ".treeSize")));
    }

    function _structHash(string memory primary, string memory m) internal view returns (bytes32) {
        bytes32 p = keccak256(bytes(primary));
        if (p == keccak256("Countersign")) return KeelsonTypes.hash(_countersign(m));
        if (p == keccak256("Verdict")) return KeelsonTypes.hash(_verdict(m));
        if (p == keccak256("Checkpoint")) return KeelsonTypes.hash(_checkpoint(m));
        if (p == keccak256("Coverage")) return KeelsonTypes.hash(_coverage(m));
        if (p == keccak256("CoverageBatch")) return KeelsonTypes.hash(_coverageBatch(m));
        if (p == keccak256("WithdrawalRequest")) {
            return KeelsonTypes.hashWithdrawal(
                vectors.readUint(string.concat(m, ".agentId")),
                uint128(vectors.readUint(string.concat(m, ".amount"))),
                vectors.readAddress(string.concat(m, ".to")),
                vectors.readUint(string.concat(m, ".nonce")),
                vectors.readUint(string.concat(m, ".deadline"))
            );
        }
        if (p == keccak256("PayoutAddress")) {
            return KeelsonTypes.hashPayoutAddress(
                vectors.readAddress(string.concat(m, ".merchant")),
                vectors.readAddress(string.concat(m, ".payout")),
                vectors.readUint(string.concat(m, ".nonce")),
                vectors.readUint(string.concat(m, ".deadline"))
            );
        }
        if (p == keccak256("Claim")) {
            return KeelsonTypes.hashClaim(
                vectors.readAddress(string.concat(m, ".account")),
                vectors.readAddress(string.concat(m, ".to")),
                vectors.readUint(string.concat(m, ".nonce")),
                vectors.readUint(string.concat(m, ".deadline"))
            );
        }
        return bytes32(0);
    }

    function test_VectorsOfEveryOnChainType() public view {
        uint256 checked;
        for (uint256 i;; ++i) {
            string memory item = string.concat("[", vm.toString(i), "]");
            if (!vm.keyExistsJson(vectors, item)) break;
            string memory primary = vectors.readString(string.concat(item, ".input.primaryType"));
            bytes32 structHash = _structHash(primary, string.concat(item, ".input.message"));
            if (structHash == bytes32(0)) continue;
            assertEq(_digest(item, structHash), vectors.readBytes32(string.concat(item, ".expected")), item);
            ++checked;
        }
        assertEq(checked, 16);
    }

    function test_TypeHashes() public pure {
        assertEq(
            KeelsonTypes.COVERAGE_TYPEHASH,
            keccak256(
                "Coverage(bytes32 coverageId,uint256 agentId,address merchant,uint96 amount,uint96 premium,"
                "uint40 expiresAt,bytes32 mandateHash,bytes32 amberCommitment,bytes32 userKeyHash)"
            )
        );
        assertEq(
            KeelsonTypes.COVERAGE_BATCH_TYPEHASH,
            keccak256(
                "CoverageBatch(uint256 agentId,bytes32 root,uint128 total,uint96 premium,uint40 expiresAt,"
                "bytes32 checkpointRoot,uint64 treeSize)"
            )
        );
        assertEq(
            KeelsonTypes.CLAIM_TYPEHASH, keccak256("Claim(address account,address to,uint256 nonce,uint256 deadline)")
        );
    }

    function test_HashTypedDataUsesVerifierDomain() public view {
        bytes32 structHash = KeelsonTypes.hash(_checkpoint("[2].input.message"));
        bytes32 domain =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Keelson"), keccak256("1"), CHAIN_ID, address(verifier)));
        assertEq(verifier.hashTypedData(structHash), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }
}
