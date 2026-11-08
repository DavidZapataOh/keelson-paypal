// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Deploy} from "../../script/Deploy.s.sol";
import {DeployVerdictVerifier} from "../../script/DeployVerdictVerifier.s.sol";
import {ISafe} from "../../script/interfaces/ISafe.sol";
import {VerdictVerifier} from "../../src/VerdictVerifier.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The release and the `VerdictVerifier` deployed by their scripts on the local EVM as Arbitrum Sepolia, with
/// Safe v1.5.0's real bytecode copied from the chain and the roles wired through the timelock.
abstract contract VerifierBase is Test {
    using stdJson for string;

    uint256 internal constant CHAIN_ID = 421614;
    /// @dev `forge inspect VerdictVerifier storageLayout`.
    uint256 internal constant MEASUREMENT_IDS_SLOT = 4;
    uint256 internal constant SIGNERS_SLOT = 7;

    DeployVerdictVerifier internal deployScript;
    VerdictVerifier internal verifier;
    AccessManager internal manager;
    TimelockController internal timelock;
    ISafe internal guardian;
    address internal owner;
    uint256 internal minDelay;
    uint256 internal signersDelay;
    uint256 internal saltCounter;

    function setUp() public virtual {
        vm.chainId(CHAIN_ID);
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments/421614.json"));
        _etchFromChain(json, ".external.safeL2");
        _etchFromChain(json, ".external.safeProxyFactory");
        _etchFromChain(json, ".external.safeFallbackHandler");
        // The verifiers the VerdictVerifier is built over; its constructor requires their code.
        _etchFromChain(json, ".external.automataDcapAttestation");
        _etchFromChain(json, ".contracts.NitroValidator");
        owner = json.readAddress(".governance.proposer");
        minDelay = json.readUint(".params.timelockMinDelay");
        signersDelay = json.readUint(".params.signersDelay");

        Deploy.Release memory release = new Deploy().run();
        manager = release.manager;
        timelock = release.timelock;
        guardian = release.guardian;

        deployScript = new DeployVerdictVerifier();
        verifier = deployScript.run();
        vm.warp(vm.getBlockTimestamp() + minDelay);
        deployScript.wire();
    }

    function _etchFromChain(string memory json, string memory key) internal {
        address account = json.readAddress(key);
        string memory params = string.concat('["', vm.toString(account), '","latest"]');
        vm.etch(account, vm.rpc(vm.envString(json.readString(".rpcEnv")), "eth_getCode", params));
    }

    function _viaTimelock(address to, bytes memory data) internal {
        bytes32 salt = bytes32(++saltCounter);
        vm.prank(owner);
        timelock.schedule(to, 0, data, bytes32(0), salt, minDelay);
        vm.warp(vm.getBlockTimestamp() + minDelay);
        timelock.execute(to, 0, data, bytes32(0), salt);
    }

    /// @dev A `SIGNERS_ROLE` call: the timelock schedules it in the AccessManager, then calls it once both delays passed.
    function _signersAction(bytes memory call) internal {
        _viaTimelock(address(manager), abi.encodeCall(manager.schedule, (address(verifier), call, 0)));
        vm.warp(vm.getBlockTimestamp() + signersDelay);
        _viaTimelock(address(verifier), call);
    }

    /// @dev Two owners approve the Safe transaction hash on-chain (Safe's pre-validated signatures) and it executes.
    function _guardianExec(address to, bytes memory data) internal {
        bytes32 safeTxHash = guardian.getTransactionHash(
            to, 0, data, ISafe.Operation.Call, 0, 0, 0, address(0), address(0), guardian.nonce()
        );
        address[] memory owners = guardian.getOwners();
        (address a, address b) = owners[0] < owners[1] ? (owners[0], owners[1]) : (owners[1], owners[0]);
        vm.prank(a);
        guardian.approveHash(safeTxHash);
        vm.prank(b);
        guardian.approveHash(safeTxHash);
        bytes memory signatures = abi.encodePacked(
            bytes32(uint256(uint160(a))), bytes32(0), uint8(1), bytes32(uint256(uint160(b))), bytes32(0), uint8(1)
        );
        assertTrue(
            guardian.execTransaction(
                to, 0, data, ISafe.Operation.Call, 0, 0, 0, address(0), payable(address(0)), signatures
            )
        );
    }

    /// @dev Writes a signer record directly into the registry: only for keys whose registration needs a live chain.
    function _storeSigner(address signer, uint8 teeKind, bytes32 measurement, uint40 registeredAt, uint40 expiresAt)
        internal
    {
        bytes32 slot = keccak256(abi.encode(signer, SIGNERS_SLOT));
        uint256 id = uint256(vm.load(address(verifier), keccak256(abi.encode(measurement, MEASUREMENT_IDS_SLOT))));
        uint256 packed = uint256(teeKind) | uint256(registeredAt) << 8 | uint256(expiresAt) << 48 | id << 128;
        vm.store(address(verifier), slot, bytes32(packed));
        vm.store(address(verifier), bytes32(uint256(slot) + 1), measurement);
    }
}
