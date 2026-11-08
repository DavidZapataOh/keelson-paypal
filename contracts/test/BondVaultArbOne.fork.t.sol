// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployBondVault} from "../script/DeployBondVault.s.sol";
import {KeelsonBondVault} from "../src/KeelsonBondVault.sol";
import {ICheckpointAnchor} from "../src/interfaces/ICheckpointAnchor.sol";
import {IERC8004Identity} from "../src/interfaces/IERC8004Identity.sol";
import {IPYUSD} from "../src/interfaces/IPYUSD.sol";
import {IVerdictVerifier} from "../src/interfaces/IVerdictVerifier.sol";
import {PasskeyAssertion} from "../src/libraries/PasskeyAssertion.sol";
import {PasskeyAssertionHarness} from "./PasskeyAssertion.t.sol";
import {ForkTest} from "./utils/Fork.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The vault's costs on Arbitrum One, where nothing is deployed yet: the vault is built over One's PYUSD and
/// ERC-8004 Identity at the release's predicted addresses, and only reads and moves tokens on the fork.
/// forge-config: default.evm_version = "osaka"
/// forge-config: ci.evm_version = "osaka"
contract BondVaultArbOneForkTest is ForkTest {
    using stdJson for string;

    KeelsonBondVault internal vault;

    function setUp() public {
        _forkAll();
        _select(42161);
        DeployBondVault script = new DeployBondVault();
        string memory json = _json();
        vault = new KeelsonBondVault(
            IPYUSD(json.readAddress(".external.pyusd")),
            IVerdictVerifier(script.predict("VerdictVerifier")),
            ICheckpointAnchor(script.predict("CheckpointAnchor")),
            IERC8004Identity(json.readAddress(".external.erc8004Identity")),
            script.predict("KeelsonReserve"),
            keccak256(bytes(json.readString(".params.logOrigin"))),
            sha256("keelson.finance"),
            script.predict("AccessManager"),
            script.params()
        );
    }

    function test_passkeyVerifyOnArbitrumOne() public {
        string memory vectors = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/passkey-assertions.json"));
        PasskeyAssertionHarness harness = new PasskeyAssertionHarness();
        for (uint256 i; i < 2; ++i) {
            string memory c = string.concat(".cases[", vm.toString(i), "]");
            PasskeyAssertion.Assertion memory a;
            a.r = vectors.readBytes32(string.concat(c, ".assertion.r"));
            a.s = vectors.readBytes32(string.concat(c, ".assertion.s"));
            a.challengeIndex = vectors.readUint(string.concat(c, ".assertion.challengeIndex"));
            a.typeIndex = vectors.readUint(string.concat(c, ".assertion.typeIndex"));
            a.authenticatorData = vectors.readBytes(string.concat(c, ".assertion.authenticatorData"));
            a.clientDataJSON = vectors.readString(string.concat(c, ".assertion.clientDataJSON"));
            assertTrue(
                harness.verify(
                    vectors.readBytes32(string.concat(c, ".challenge")),
                    a,
                    vault.rpIdHash(),
                    vectors.readBytes32(string.concat(c, ".qx")),
                    vectors.readBytes32(string.concat(c, ".qy"))
                )
            );
            emit log_named_uint(
                string.concat("verify on Arbitrum One, ", vectors.readString(string.concat(c, ".name"))),
                vm.lastCallGas().gasTotalUsed
            );
        }
    }

    /// @dev A fresh key funded from the pinned holder signs the authorization, as a funder would.
    function test_depositWithAuthorizationOnArbitrumOne() public {
        (address from, uint256 pk) = makeAddrAndKey("one funder");
        _fundFromHolder(from, 2e6);
        bytes32 salt = "one";
        bytes memory sig = _signReceiveWithAuthorization(
            pk, address(vault), 1e6, 0, type(uint256).max, keccak256(abi.encode(1, salt))
        );
        vault.depositWithAuthorization(1, from, 1e6, 0, type(uint256).max, salt, sig);
        emit log_named_uint("depositWithAuthorization on Arbitrum One, transaction", vm.lastCallGas().gasTotalUsed);
        assertEq(vault.bonds(1).free, 1e6);
    }
}
