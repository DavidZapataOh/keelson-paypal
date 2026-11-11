// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {AmberContradictionCourt} from "../../src/AmberContradictionCourt.sol";
import {KeelsonTypes} from "../../src/libraries/KeelsonTypes.sol";
import {RFC6962} from "../../src/libraries/RFC6962.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice The evidence a purchase's countersign binds, as `@keelson/evidence` builds it: a manifest of `api.product`,
/// `api.cart`, `llm.observation` and the `tlsn.web_fact` item, whose document is the JCS of the notary's answer.
library AmberEvidence {
    using Strings for uint256;
    using Strings for address;

    /// @notice What the notary answered for a session, as the agent seals it.
    struct Notarized {
        KeelsonTypes.WebFact fact;
        bytes32 digest;
        bytes signature;
        address signer;
        string url;
        bytes committed;
        bytes16 blinder;
    }

    uint64 internal constant SIZE = 4;
    uint64 internal constant WEB_FACT_INDEX = 3;

    /// @notice The `tlsn.web_fact` item of `n` under `salt`, and the evidence root over it and the other items.
    function item(Notarized memory n, bytes32 salt)
        internal
        view
        returns (AmberContradictionCourt.EvidenceItem memory it, bytes32 root)
    {
        (it.document, it.digestAt) = document(n);
        it.salt = salt;
        it.index = WEB_FACT_INDEX;
        it.size = SIZE;
        it.path = new bytes32[](2);
        it.path[0] = otherLeaf("llm.observation", "text/plain; charset=utf-8");
        it.path[1] = RFC6962.hashChildren(
            otherLeaf("api.product", "application/json"), otherLeaf("api.cart", "application/json")
        );
        root = RFC6962.hashChildren(
            it.path[1], RFC6962.hashChildren(it.path[0], leaf("tlsn.web_fact", salt, it.document))
        );
    }

    /// @notice The JCS document (members in code-point order, no whitespace), and where its `digest` member starts.
    function document(Notarized memory n) internal pure returns (bytes memory doc, uint256 digestAt) {
        bytes memory head = abi.encodePacked(
            '{"blinder":"',
            _bare(abi.encodePacked(n.blinder)),
            '","chain_id":421614,"committed":"',
            _bare(n.committed),
            '",'
        );
        KeelsonTypes.WebFact memory f = n.fact;
        doc = abi.encodePacked(
            head,
            abi.encodePacked(
                '"digest":"',
                uint256(n.digest).toHexString(32),
                '","signature":"',
                _hex(n.signature),
                '","signer":"',
                n.signer.toHexString(),
                '","url":"',
                n.url,
                '",'
            ),
            abi.encodePacked(
                '"web_fact":{"attId":"',
                uint256(f.attId).toHexString(32),
                '","hostHash":"',
                uint256(f.hostHash).toHexString(32),
                '","rangeCommitment":"',
                uint256(f.rangeCommitment).toHexString(32),
                '","tCapture":',
                uint256(f.tCapture).toString(),
                ',"urlPathHash":"',
                uint256(f.urlPathHash).toHexString(32),
                '"}}'
            )
        );
        digestAt = head.length;
    }

    function leaf(string memory itemType, bytes32 salt, bytes memory content) internal pure returns (bytes32) {
        return sha256(
            abi.encodePacked(
                bytes1(0x00),
                "keelson/evidence-item/v1",
                salt,
                itemType,
                bytes1(0x00),
                "application/json",
                bytes1(0x00),
                sha256(content)
            )
        );
    }

    function otherLeaf(string memory itemType, string memory mediaType) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(itemType, bytes1(0x00), mediaType));
    }

    function _hex(bytes memory b) private pure returns (string memory) {
        return string.concat("0x", _bare(b));
    }

    function _bare(bytes memory b) private pure returns (string memory) {
        bytes memory out = new bytes(2 * b.length);
        bytes16 digits = "0123456789abcdef";
        for (uint256 i; i < b.length; ++i) {
            out[2 * i] = digits[uint8(b[i]) >> 4];
            out[2 * i + 1] = digits[uint8(b[i]) & 0x0f];
        }
        return string(out);
    }
}
