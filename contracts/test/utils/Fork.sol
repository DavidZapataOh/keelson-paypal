// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Deploy} from "../../script/Deploy.s.sol";
import {IPyusd} from "./IPyusd.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Base for tests against forks of every chain in `deployments/`, at the block each registry pins.
abstract contract ForkTest is Test {
    using stdJson for string;

    /// @dev keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 internal constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;
    /// @dev keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)")
    bytes32 internal constant PERMIT_TYPEHASH = 0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9;

    uint256[] internal CHAIN_IDS = [uint256(421614), 42161, 11155111];

    mapping(uint256 chainId => uint256 forkId) private _forks;

    function _forkAll() internal {
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            string memory json = _jsonOf(CHAIN_IDS[i]);
            _forks[CHAIN_IDS[i]] = vm.createFork(vm.envString(json.readString(".rpcEnv")), json.readUint(".forkBlock"));
        }
    }

    /// @dev Tests that need P256VERIFY at 0x100 (as on Arbitrum and Sepolia) annotate their contract with
    /// an inline `evm_version = "osaka"` config.
    function _select(uint256 chainId) internal {
        vm.selectFork(_forks[chainId]);
        assertEq(vm.getChainId(), chainId, "fork chain id");
    }

    function _jsonOf(uint256 chainId) internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/deployments/", vm.toString(chainId), ".json"));
    }

    function _json() internal view returns (string memory) {
        return _jsonOf(vm.getChainId());
    }

    function _pyusd() internal view returns (IPyusd) {
        return IPyusd(_json().readAddress(".external.pyusd"));
    }

    /// @dev Funder keys hold faucet PYUSD on the testnets.
    function _funder(uint256 i) internal view returns (address account, uint256 pk) {
        string[] memory keys = vm.split(vm.envString("KEELSON_FUNDER_KEYS"), ",");
        pk = vm.parseUint(keys[i]);
        account = vm.addr(pk);
    }

    /// @dev Arbitrum One has no faucet: moves real tokens from the pinned holder with a plain transfer.
    function _fundFromHolder(address to, uint256 amount) internal {
        assertEq(vm.getChainId(), 42161, "holder only on Arbitrum One");
        vm.prank(_json().readAddress(".external.pyusdHolder"));
        assertTrue(_pyusd().transfer(to, amount));
    }

    /// @dev The real `freeze`, called by the real asset-protection role holder.
    function _freeze(address who) internal {
        vm.prank(_json().readAddress(".external.pyusdAssetProtector"));
        _pyusd().freeze(who);
    }

    function _signReceiveWithAuthorization(
        uint256 pk,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, vm.addr(pk), to, value, validAfter, validBefore, nonce)
        );
        return _sign(pk, structHash);
    }

    function _signPermit(uint256 pk, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        address owner = vm.addr(pk);
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, _pyusd().nonces(owner), deadline));
        return _sign(pk, structHash);
    }

    function _sign(uint256 pk, bytes32 structHash) private view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _pyusd().DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Runs the release deployment on the selected fork as the real deployer EOA.
    function _deployRelease() internal returns (Deploy.Release memory) {
        return new Deploy().run();
    }
}
