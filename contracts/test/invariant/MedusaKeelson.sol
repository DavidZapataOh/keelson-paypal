// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vector} from "../../script/CoverageVector.sol";
import {KeelsonBondVault} from "../../src/KeelsonBondVault.sol";
import {KeelsonReserve} from "../../src/KeelsonReserve.sol";
import {KeelsonRoles} from "../../src/access/KeelsonRoles.sol";
import {KeelsonDeployer} from "../../src/deploy/KeelsonDeployer.sol";
import {IERC8004Identity} from "../../src/interfaces/IERC8004Identity.sol";
import {IVerdictVerifier} from "../../src/interfaces/IVerdictVerifier.sol";
import {KeelsonTypes} from "../../src/libraries/KeelsonTypes.sol";
import {PasskeyAssertion} from "../../src/libraries/PasskeyAssertion.sol";
import {IPyusd} from "../utils/IPyusd.sol";
import {KeelsonHandler} from "./KeelsonHandler.sol";
import {Properties} from "./Properties.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {Vm} from "forge-std/Vm.sol";

/// @notice What Medusa's harness needs from `deployments/421614.json`, `engine/tee/measurements.json` and the live
/// coverage vectors, as constants: Medusa has no file or environment cheatcodes. `test_MedusaConstantsMatchRegistry`
/// checks every value against those files.
library MedusaFork {
    uint256 internal constant CHAIN_ID = 421614;
    /// @dev The first block where the `VerdictVerifier` and `CheckpointAnchor` the vectors and verdicts need exist.
    uint256 internal constant FORK_BLOCK = 327_231_200;
    /// @dev `FORK_BLOCK`'s timestamp: Medusa's chain starts from its own clock, not the forked block's.
    uint256 internal constant FORK_TIMESTAMP = 1_794_136_673;
    uint40 internal constant DISPUTE_WINDOW = 600;
    string internal constant RELEASE = "keelson/v1";

    address internal constant PYUSD = 0x637A1259C6afd7E3AdF63993cA7E58BB438aB1B1;
    address internal constant PYUSD_HOLDER = 0xcc9644EC26A647de0B9b86f1560d5180232f70a3;
    address internal constant ASSET_PROTECTOR = 0xC7Aa9798bE85aD3B628eE71519B38D7057f8Cd7E;
    address internal constant IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address internal constant PROPOSER = 0x9c0215b66F6a64c34CCb0126Cb8d027689Fa68b9;
    address internal constant ACCESS_MANAGER = 0x57c30a4a175978673bAD2B2B2D3667966cd58314;
    address internal constant TIMELOCK = 0xEDD241A9B8cf55765eDA7182483351555cf3E07e;
    address internal constant GUARDIAN = 0x1cd0152d2d954Fc8c9436986C9F4B2C15903eF5C;
    address internal constant DEPLOYER = 0x539638ee1C4021730f9fA63b725c7E9bA02b714A;
    address internal constant VERIFIER = 0xe16E8767EC1DA59Ef0D9Bc7851637E4D22352d96;
    address internal constant VAULT = 0xb39898Ef4333f3CB32d1B420E744f5a1Aa2ae2Bf;
    address internal constant RESERVE = 0xd10Cb524B3C5EC3c60A420e8900e4f8C5aB88972;
    address internal constant DEMO_OPERATOR = 0xcdA4d2330C027Aa025f4A14b525a386CE02AD98f;
    address internal constant MERCHANT_OF_RECORD = 0x467D2beBb479D9B80Ab1c461243E05A2b82387d8;
    uint256 internal constant AGENT_ID = 351;

    bytes32 internal constant TDX_MEASUREMENT = 0x0f02189b65737875b58db9e50801fe710433cc7580481670b4a08b9020dd62ae;
    bytes32 internal constant NITRO_MEASUREMENT = 0xc3077e2be4b9b20d3abdc05d577f4ccba942b32580b08a1bff1a2b23baf8baf7;

    function vaultArgs() internal pure returns (bytes memory) {
        return hex"000000000000000000000000637a1259c6afd7e3adf63993ca7e58bb438ab1b1000000000000000000000000e16e8767ec1da59ef0d9bc7851637e4d22352d96000000000000000000000000049621749722d0660d5026456f25192fbd9a57ab0000000000000000000000008004a818bfb912233c491871b3d84c89a494bd9e000000000000000000000000d10cb524b3c5ec3c60a420e8900e4f8c5ab88972e0c0e434acc96fa35fb684556f51efd752a89b3db13536efbf1e4a0d85e800d91071caa839ec25d37b233c1d4b37fd3a9d1b0a09830e137e452105c07d6fc4f700000000000000000000000057c30a4a175978673bad2b2b2d3667966cd5831400000000000000000000000000000000000000000000000000000000000002580000000000000000000000000000000000000000000000000000000000000078000000000000000000000000000000000000000000000000000000000000003c00000000000000000000000000000000000000000000000000000000000003840000000000000000000000000000000000000000000000000000000005f5e1000000000000000000000000000000000000000000000000000000000000000e10000000000000000000000000000000000000000000000000000000003b9aca00";
    }

    function reserveArgs() internal pure returns (bytes memory) {
        return hex"000000000000000000000000637a1259c6afd7e3adf63993ca7e58bb438ab1b1000000000000000000000000e16e8767ec1da59ef0d9bc7851637e4d22352d96000000000000000000000000049621749722d0660d5026456f25192fbd9a57ab000000000000000000000000b39898ef4333f3cb32d1b420e744f5a1aa2ae2bfe0c0e434acc96fa35fb684556f51efd752a89b3db13536efbf1e4a0d85e800d900000000000000000000000057c30a4a175978673bad2b2b2d3667966cd58314000000000000000000000000000000000000000000000000000000000000025800000000000000000000000000000000000000000000000000000000000151800000000000000000000000000000000000000000000000000000000000000e10000000000000000000000000000000000000000000000000000000003b9aca00";
    }

    /// @notice The vector `i` (`coverage-2of2-webauthn`, `coverage-2of2-payment`, `coverage-degraded`) as
    /// `CoverageVector.read` builds it for the demo merchant.
    function vector(uint256 i) internal pure returns (Vector memory v) {
        v = i == 0 ? _vector0() : i == 1 ? _vector1() : _vector2();
        v.countersigs = bytes.concat(v.tdx, v.nitro);
        uint96 amount = uint96(v.countersign.amount * 10_000);
        v.coverage = KeelsonTypes.Coverage({
            coverageId: v.countersign.requestId,
            agentId: v.countersign.agentId,
            merchant: MERCHANT_OF_RECORD,
            amount: amount,
            premium: uint96(amount * 100 / 10_000),
            expiresAt: v.countersign.issuedAt + DISPUTE_WINDOW,
            mandateHash: v.countersign.mandateHash,
            amberCommitment: keccak256(abi.encode("amber", v.countersign.requestId)),
            userKeyHash: v.userKeyHash
        });
    }

    /// @dev `test/vectors/coverage-2of2-webauthn.json`.
    function _vector0() private pure returns (Vector memory v) {
        v.countersign = KeelsonTypes.Countersign({
            requestId: 0x0000000000000000000000000000000001a1baef278b0910d87b947644d1d15c,
            mandateHash: 0x356b01946c12be3e639119fbb2b4b9a4ec256f6af8b2671c05048d3010fe9775,
            mandateCommitment: 0x046816dd31428e952fecb66b8d7b3e1a82096878ce460f5b47b077a63e278932,
            cartHash: 0xc74c44e1b852d5134056bae404a00880cc39512ba4e0d93cdf700d03222f03a1,
            agentId: 351,
            merchantId: 0x1f0a71f468ae72a38151f84f8077b9209dfd331a519173426d07258de56c366c,
            amount: 9400,
            currency: 840,
            category: 21,
            evidenceRoot: 0x10bfb1ea4b0c33934ba1e7df32b2084977cf966411447ef78a56005670238d24,
            evalHash: 0xe7cf796fce7b902ed419ac46830f51ef86928c7db8353ccce3a52b766764be38,
            policySetHash: 0x76e3a5959eddc084b99b80a7376d85eeb86f005a7ce447420ac67c3e80902123,
            decision: 1,
            failedFieldsMask: 0,
            issuedAt: 1794137598,
            expiresAt: 1794138498
        });
        v.hSd = 0xf3d2c599fe71f0b7b756c8a49b557128b8bab97d510fd104f331ce052e1cbd30;
        v.assertion = PasskeyAssertion.Assertion({
            r: 0xba2591651bdc3f97adc23523715ddc721cffc10773c7a56a0d4e67d1d2120d0e,
            s: 0x3bf47cc0327a16c41b9ab5b88d9b7ce519b65939f87b6c55becb49544c83ced9,
            challengeIndex: 23,
            typeIndex: 1,
            authenticatorData: hex"1071caa839ec25d37b233c1d4b37fd3a9d1b0a09830e137e452105c07d6fc4f70500000002",
            clientDataJSON: string(
                hex"7b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a224e5773426c477753766a356a6b526e3773725335704f776c62327234736d63634251534e4d42442d6c3355222c226f726967696e223a2268747470733a2f2f6170702e6b65656c736f6e2e66696e616e6365222c2263726f73734f726967696e223a66616c73657d"
            )
        });
        v.qx = 0xf2fe60007e51a237edb579a93c8ccce4b4379cb40ff718307c9c0b4ddc120980;
        v.qy = 0x44ae04eafd68edc5a17121d8056a22730eb912ba120b2b00585ddae37edd3ff8;
        v.tdx =
            hex"d671cfdfdb0d228be839c19a95827345db62fe7fd40d4c13169e577029a87568729e348b047cd0b9e0d77f4dda00ad24334be9f409466e7f6fa854f73b72b1291b";
        v.nitro =
            hex"7084ab89cf52054acdf6e4d59892f15984b110e664d3e2a070fb97d6e0cd9f9e53dbf3942c4f173c3462f2cf23c20bfb8241bd87c0fe5069ae0905432278bc211b";
        v.digest = 0xe41716a89fbfbae3aa7e267755509ae6d88728efe10a70be358134fe4ef93f35;
        v.userKeyHash = 0xcb05e7996a07642e49b5b9083a59454a12a7ff96ddaa4bb05650f1853a0f5ef4;
        v.degraded = false;
        v.vault = 0x69ccD2fB3a85f590F2A8f431cca3ecc2e9Bf3c14;
    }

    /// @dev `test/vectors/coverage-2of2-payment.json`.
    function _vector1() private pure returns (Vector memory v) {
        v.countersign = KeelsonTypes.Countersign({
            requestId: 0x0000000000000000000000000000000001a1baef1c220e9f63fbaff0220eef4f,
            mandateHash: 0xc0c3657b34f46ffab5aeac743f97e257069f1326c9abb11e57e591c731763151,
            mandateCommitment: 0x0ce6e684f178ccf0e49c77d309604e5abbceedd581a377f89de8ee6a4877ee34,
            cartHash: 0xc74c44e1b852d5134056bae404a00880cc39512ba4e0d93cdf700d03222f03a1,
            agentId: 351,
            merchantId: 0x1f0a71f468ae72a38151f84f8077b9209dfd331a519173426d07258de56c366c,
            amount: 9400,
            currency: 840,
            category: 21,
            evidenceRoot: 0xc51a82b1ee5a9b92271572ec6b11a99fc2bfdb8578f58978d516e41d5c9f6e98,
            evalHash: 0xbaa6647a4968fcea735ec855fc14ecec22b5663e8bcaf41fdacaa35f98d66884,
            policySetHash: 0x76e3a5959eddc084b99b80a7376d85eeb86f005a7ce447420ac67c3e80902123,
            decision: 1,
            failedFieldsMask: 0,
            issuedAt: 1794137596,
            expiresAt: 1794138496
        });
        v.hSd = 0x27b49bbd400b4e224ef8e2cd4ee17ca2b035bc4c2162cf098e7931a59900c291;
        v.assertion = PasskeyAssertion.Assertion({
            r: 0x0d09c4d6b5353693ea7fb7c5f319a19a22e0b06845cf2de13add8227bdaaa0fa,
            s: 0x69eff46a4e0fb386235f7918cf053dd8a2ac25a450f8bbc4f24f97e40d7413df,
            challengeIndex: 22,
            typeIndex: 1,
            authenticatorData: hex"1071caa839ec25d37b233c1d4b37fd3a9d1b0a09830e137e452105c07d6fc4f70500000002",
            clientDataJSON: string(
                hex"7b2274797065223a227061796d656e742e676574222c226368616c6c656e6765223a22774d4e6c657a5430625f71317271783050356669567761664579624a71374565562d5752787a46324d5645222c226f726967696e223a2268747470733a2f2f6170702e6b65656c736f6e2e66696e616e6365222c2263726f73734f726967696e223a66616c73652c227061796d656e74223a7b2272704964223a226b65656c736f6e2e66696e616e6365222c22746f704f726967696e223a2268747470733a2f2f6170702e6b65656c736f6e2e66696e616e6365222c2270617965654e616d65223a224b65656c736f6e222c2270617965654f726967696e223a2268747470733a2f2f6b65656c736f6e2e66696e616e6365222c227061796d656e74456e7469746965734c6f676f73223a5b5d2c22746f74616c223a7b2276616c7565223a223130302e3030222c2263757272656e6379223a22555344227d2c22696e737472756d656e74223a7b2269636f6e223a22646174613a696d6167652f7376672b786d6c2c25334373766720786d6c6e733d27687474703a2f2f7777772e77332e6f72672f323030302f737667272077696474683d27333227206865696768743d27333227253345253343726563742077696474683d27333227206865696768743d273332272072783d2736272066696c6c3d27253233313131272f2533452533432f737667253345222c22646973706c61794e616d65223a224b65656c736f6e206d616e64617465227d7d7d"
            )
        });
        v.qx = 0x3596ac5ce2f708ff9506987f8f27837d56af5acc33ecf899e2177b16fb6d07b9;
        v.qy = 0xaf4be6996d6c4a35e788fa9408a0198ab28b4425a6f259a585da54d72289c673;
        v.tdx =
            hex"3d5be781a039d8cf3f4eb83723d8756b42e8580deb06b8fc3a463376dd6acbf147f7fe759d029fa83fb87cf5b223430f8f0ba3c4eefb1d00cfe990cb42e7426b1c";
        v.nitro =
            hex"d3cc318d896febb54c8a52230a05482dba586a5d7e1feaeb7cda14c2a1448d66287e3fa3f986e87a493cbe0e5e4b37e336f9058f5c695dee469453837d597e301c";
        v.digest = 0x9eaeba59102306e4b884407aa79f1288980283fd3397455f81604b7cd976a580;
        v.userKeyHash = 0xa48e2e2191ccf93b58317b2f0501de8ce0e1334f06580275492813132d527f89;
        v.degraded = false;
        v.vault = 0x69ccD2fB3a85f590F2A8f431cca3ecc2e9Bf3c14;
    }

    /// @dev `test/vectors/coverage-degraded.json`.
    function _vector2() private pure returns (Vector memory v) {
        v.countersign = KeelsonTypes.Countersign({
            requestId: 0x0000000000000000000000000000000001a1baef2ddc212ccd4fc893ac5cf997,
            mandateHash: 0x71a4302391a6f1c722c86bc462fa78503235c195b033633ea6198a1449384b07,
            mandateCommitment: 0x0b4c9be8c1c8da176e452a182b1351e08ef093b70b0ef9852a2257c1b109017d,
            cartHash: 0xc74c44e1b852d5134056bae404a00880cc39512ba4e0d93cdf700d03222f03a1,
            agentId: 351,
            merchantId: 0x1f0a71f468ae72a38151f84f8077b9209dfd331a519173426d07258de56c366c,
            amount: 9400,
            currency: 840,
            category: 21,
            evidenceRoot: 0x3e0501755e55414b27799cb71617a96f7ff493bd753b3c05500cbfc4b55fead8,
            evalHash: 0xb3bfe3b2499c6355ec0afd4d64c88bfeb5944a45cc2cd58f33b35b730ab96400,
            policySetHash: 0x76e3a5959eddc084b99b80a7376d85eeb86f005a7ce447420ac67c3e80902123,
            decision: 1,
            failedFieldsMask: 0,
            issuedAt: 1794137600,
            expiresAt: 1794138500
        });
        v.hSd = 0x71af5c796c1b8b0ced49e983f776e82e6032d4916af648518f365c76a59bf1c5;
        v.assertion = PasskeyAssertion.Assertion({
            r: 0xc2ef0e44e83bbb48c7ce4784cd108f2ebe57610cb9c57c98df0a092f298ead79,
            s: 0x33084433498aedc925d7f72c2149b1a194e088d2f2b1f3731860e0e9ef514a85,
            challengeIndex: 23,
            typeIndex: 1,
            authenticatorData: hex"1071caa839ec25d37b233c1d4b37fd3a9d1b0a09830e137e452105c07d6fc4f70500000002",
            clientDataJSON: string(
                hex"7b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a22636151774935476d38636369794776455976703455444931775a57774d324d2d70686d4b46456b34537763222c226f726967696e223a2268747470733a2f2f6170702e6b65656c736f6e2e66696e616e6365222c2263726f73734f726967696e223a66616c73652c226f746865725f6b6579735f63616e5f62655f61646465645f68657265223a22646f206e6f7420636f6d7061726520636c69656e74446174614a534f4e20616761696e737420612074656d706c6174652e205365652068747470733a2f2f676f6f2e676c2f796162506578227d"
            )
        });
        v.qx = 0xd77979d2cbd5887eead04bc3abeb062ef85f7b3772dfa2ca545ff7a826612e0f;
        v.qy = 0x755deb8367edca4125bab479df51752d2ddc13db773171da16603832f1f06405;
        v.tdx =
            hex"7ae5d0b292933a4a8e6c57e82d9e2bfcb8f2632542068112f9d0e9e7f15b3d65139768e75f9fdfc629b5a86d023965a7288ee0f0532441c9b03ab4ac622172991b";
        v.nitro = hex"";
        v.digest = 0x278eeff8d9cc290880f4a5f7858345d623d4ab5450795c73be71cd7b965e0c44;
        v.userKeyHash = 0xd74a2eaba9b27836518ffe74ee5bdc3d823f58849b52cfef2d3c472ab1323645;
        v.degraded = true;
        v.vault = 0x69ccD2fB3a85f590F2A8f431cca3ecc2e9Bf3c14;
    }
}

/// @notice EIP-7951 `P256VERIFY` (Arbitrum's RIP-7212 precompile at `0x100`), computed with OpenZeppelin's Solidity
/// verifier, for an EVM that predates the precompile. Returns `uint256(1)` for a valid signature and nothing otherwise.
/// @dev OpenZeppelin's `verifySolidity` also rejects `s > N/2`; `P256.verifyNative`, the only caller here, rejects those
/// before it calls the precompile, so the two agree on every call it makes.
contract P256VerifyPrecompile {
    fallback(bytes calldata input) external returns (bytes memory) {
        if (input.length != 160) return "";
        (bytes32 h, bytes32 r, bytes32 s, bytes32 qx, bytes32 qy) =
            abi.decode(input, (bytes32, bytes32, bytes32, bytes32, bytes32));
        return P256.verifySolidity(h, r, s, qx, qy) ? abi.encode(uint256(1)) : bytes("");
    }
}

/// @notice Medusa's entry point: deploys the release on its fork of Arbitrum Sepolia the way `DeployBondVault` and
/// `DeployReserve` do (CREATE3 through the real `KeelsonDeployer` as its owner, roles wired through the real timelock),
/// installs the fork-only verdict signers, funds the depositors and the reserve from the pinned PYUSD holder, and
/// forwards every action to a `KeelsonHandler`. Each `property_<name>` is the matching `Properties` check.
contract MedusaKeelson is Properties {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev Signer records in `VerdictVerifier` storage (`forge inspect VerdictVerifier storageLayout`).
    uint256 internal constant MEASUREMENT_IDS_SLOT = 4;
    uint256 internal constant SIGNERS_SLOT = 7;
    uint256 internal constant FUNDING = 1_000e6;
    uint256 internal constant STAKE = 1_000e6;

    KeelsonHandler internal immutable h;

    constructor() {
        if (block.chainid != MedusaFork.CHAIN_ID) vm.chainId(MedusaFork.CHAIN_ID);
        // Medusa has no `vm.getBlockTimestamp`: the clock is read once here and carried explicitly.
        // forge-lint: disable-next-line(environment-read-across-mutation)
        uint256 time = block.timestamp < MedusaFork.FORK_TIMESTAMP ? MedusaFork.FORK_TIMESTAMP : block.timestamp;
        vm.warp(time);
        if (block.number < MedusaFork.FORK_BLOCK) vm.roll(MedusaFork.FORK_BLOCK);
        _ensureP256Precompile();

        uint256 operatorKey = uint256(keccak256("medusa agent owner"));
        vm.prank(MedusaFork.DEMO_OPERATOR);
        IERC8004Identity(MedusaFork.IDENTITY)
            .transferFrom(MedusaFork.DEMO_OPERATOR, vm.addr(operatorKey), MedusaFork.AGENT_ID);
        (KeelsonBondVault vault, KeelsonReserve reserve, uint256 wiredAt) = _deployRelease(time);

        IVerdictVerifier verifier = vault.verifier();
        uint256 tdxKey = uint256(keccak256("medusa tdx verdict signer"));
        uint256 nitroKey = uint256(keccak256("medusa nitro verdict signer"));
        _installSigner(verifier, vm.addr(tdxKey), 1, MedusaFork.TDX_MEASUREMENT, wiredAt);
        _installSigner(verifier, vm.addr(nitroKey), 2, MedusaFork.NITRO_MEASUREMENT, wiredAt);
        require(verifier.isActive(vm.addr(tdxKey), 1) && verifier.isActive(vm.addr(nitroKey), 2), "verdict signers");
        (uint64 treeSize, bytes32 root,) = vault.anchor().latest(vault.logOrigin());
        require(treeSize != 0, "anchored checkpoint");

        IPyusd pyusd = IPyusd(MedusaFork.PYUSD);
        uint256[] memory funderKeys = new uint256[](3);
        for (uint256 i; i < 3; ++i) {
            funderKeys[i] = uint256(keccak256(abi.encode("medusa funder", i)));
            vm.prank(MedusaFork.PYUSD_HOLDER);
            require(pyusd.transfer(vm.addr(funderKeys[i]), FUNDING), "fund depositor");
        }
        address staker = vm.addr(uint256(keccak256("medusa reserve staker")));
        vm.prank(MedusaFork.PYUSD_HOLDER);
        require(pyusd.transfer(staker, STAKE), "fund staker");
        vm.prank(staker);
        pyusd.approve(address(reserve), STAKE);
        vm.prank(staker);
        reserve.deposit(STAKE, staker);

        Vector[] memory vectors = new Vector[](3);
        for (uint256 i; i < 3; ++i) {
            vectors[i] = MedusaFork.vector(i);
        }
        h = new KeelsonHandler(
            vault,
            pyusd,
            MedusaFork.AGENT_ID,
            operatorKey,
            funderKeys,
            vectors,
            KeelsonHandler.Config({
                reserve: reserve,
                verifier: verifier,
                tdxKey: tdxKey,
                nitroKey: nitroKey,
                merchantKey: uint256(keccak256("medusa merchant")),
                treeSize: treeSize,
                checkpointRoot: root,
                guardian: MedusaFork.GUARDIAN,
                assetProtector: MedusaFork.ASSET_PROTECTOR,
                recordLogs: false
            })
        );
        // Bond for the three coverages; the depositors keep the rest for the fuzzer.
        for (uint256 i; i < 3; ++i) {
            h.deposit(i, FUNDING / 2, 0);
        }
    }

    function handler() internal view override returns (KeelsonHandler) {
        return h;
    }

    // ---------------------------------------------------------------- actions

    function deposit(uint256 funderSeed, uint256 amountSeed, uint256 agentSeed) external {
        h.deposit(funderSeed, amountSeed, agentSeed);
    }

    function lock(uint256 which) external {
        h.lock(which);
    }

    function release(uint256 which) external {
        h.release(which);
    }

    function request(uint256 amountSeed) external {
        h.request(amountSeed);
    }

    function complete(uint256 which) external {
        h.complete(which);
    }

    function warp(uint256 secondsSeed) external {
        h.warp(secondsSeed);
    }

    function slash(uint256 seed, bool degraded, bool validSig) external {
        h.slash(seed, degraded, validSig);
    }

    function executeSlash(uint256 seed) external {
        h.executeSlash(seed);
    }

    function vetoSlash(uint256 seed) external {
        h.vetoSlash(seed);
    }

    function claim(uint256 seed) external {
        h.claim(seed);
    }

    function payWarranty(uint256 seed, bool degraded) external {
        h.payWarranty(seed, degraded);
    }

    function freeze(uint256 who) external {
        h.freeze(who);
    }

    function unfreeze(uint256 who) external {
        h.unfreeze(who);
    }

    function pauseToken() external {
        h.pauseToken();
    }

    function unpauseToken() external {
        h.unpauseToken();
    }

    function pauseVault() external {
        h.pauseVault();
    }

    function unpauseVault() external {
        h.unpauseVault();
    }

    // ---------------------------------------------------------------- properties

    function property_conservation() external view returns (bool holds) {
        (holds,) = checkConservation();
    }

    function property_settledUnique() external view returns (bool holds) {
        (holds,) = checkSettledUnique();
    }

    function property_slashWithinCoverage() external view returns (bool holds) {
        (holds,) = checkSlashWithinCoverage();
    }

    function property_noUnsignedSlash() external view returns (bool holds) {
        (holds,) = checkNoUnsignedSlash();
    }

    function property_noEarlyWithdrawal() external view returns (bool holds) {
        (holds,) = checkNoEarlyWithdrawal();
    }

    function property_withdrawalRecipient() external view returns (bool holds) {
        (holds,) = checkWithdrawalRecipient();
    }

    function property_payeeDelta() external view returns (bool holds) {
        (holds,) = checkPayeeDelta();
    }

    function property_outflowsEntitled() external view returns (bool holds) {
        (holds,) = checkOutflowsEntitled();
    }

    function property_slashedDigest() external view returns (bool holds) {
        (holds,) = checkSlashedDigest();
    }

    function property_liable() external view returns (bool holds) {
        (holds,) = checkLiable();
    }

    function property_degradedTdxOnly() external view returns (bool holds) {
        (holds,) = checkDegradedTdxOnly();
    }

    function property_degradedQueued() external view returns (bool holds) {
        (holds,) = checkDegradedQueued();
    }

    // ---------------------------------------------------------------- setup

    /// @dev The wycheproof vector OpenZeppelin's `P256` probes the precompile with.
    function _ensureP256Precompile() internal {
        (, bytes memory out) = address(0x100)
            .staticcall(
                abi.encode(
                    0xbb5a52f42f9c9261ed4361f59422a1e30036e7c32b270c8807a419feca605023,
                    uint256(5),
                    uint256(1),
                    0xa71af64de5126a4a4e02b7922d66ce9415ce88a4c9d25514d91082c8725ac957,
                    0x5d47723c8fbe580bb369fec9c2665d8e30a435b9932645482e7c9f11e872296b
                )
            );
        if (out.length == 32 && abi.decode(out, (uint256)) == 1) return;
        vm.etch(address(0x100), address(new P256VerifyPrecompile()).code);
    }

    /// @dev `DeployBondVault.run` and `DeployReserve.run`, then their `wire`, as the deployer EOA; like the scripts, the
    /// wiring is skipped where the `AccessManager` already maps the roles.
    function _deployRelease(uint256 time)
        internal
        returns (KeelsonBondVault vault, KeelsonReserve reserve, uint256 wiredAt)
    {
        KeelsonDeployer deployer = KeelsonDeployer(MedusaFork.DEPLOYER);
        vm.prank(MedusaFork.PROPOSER);
        vault = KeelsonBondVault(
            deployer.deploy(
                _salt("KeelsonBondVault"), abi.encodePacked(type(KeelsonBondVault).creationCode, MedusaFork.vaultArgs())
            )
        );
        vm.prank(MedusaFork.PROPOSER);
        reserve = KeelsonReserve(
            deployer.deploy(
                _salt("KeelsonReserve"), abi.encodePacked(type(KeelsonReserve).creationCode, MedusaFork.reserveArgs())
            )
        );
        require(address(vault) == MedusaFork.VAULT && address(reserve) == MedusaFork.RESERVE, "release addresses");

        AccessManager manager = AccessManager(MedusaFork.ACCESS_MANAGER);
        bytes4[] memory parameters = new bytes4[](2);
        parameters[0] = KeelsonBondVault.setParams.selector;
        parameters[1] = KeelsonBondVault.setRateLimit.selector;
        bytes4[] memory guardian = new bytes4[](3);
        guardian[0] = KeelsonBondVault.pause.selector;
        guardian[1] = KeelsonBondVault.unpause.selector;
        guardian[2] = KeelsonBondVault.vetoSlash.selector;
        address[] memory targets = new address[](2);
        targets[0] = targets[1] = address(manager);
        uint256[] memory values = new uint256[](2);
        bytes[] memory payloads = new bytes[](2);
        payloads[0] =
            abi.encodeCall(manager.setTargetFunctionRole, (address(vault), parameters, KeelsonRoles.PARAMETERS_ROLE));
        payloads[1] =
            abi.encodeCall(manager.setTargetFunctionRole, (address(vault), guardian, KeelsonRoles.GUARDIAN_ROLE));
        bytes4[] memory reserveParameters = new bytes4[](2);
        reserveParameters[0] = KeelsonReserve.setCooldown.selector;
        reserveParameters[1] = KeelsonReserve.setRateLimit.selector;
        bytes memory reservePayload = abi.encodeCall(
            manager.setTargetFunctionRole, (address(reserve), reserveParameters, KeelsonRoles.PARAMETERS_ROLE)
        );

        TimelockController timelock = TimelockController(payable(MedusaFork.TIMELOCK));
        uint256 delay = timelock.getMinDelay();
        bool vaultWired = manager.getTargetFunctionRole(address(vault), KeelsonBondVault.vetoSlash.selector)
                == KeelsonRoles.GUARDIAN_ROLE
            && manager.getTargetFunctionRole(address(vault), KeelsonBondVault.setParams.selector)
                == KeelsonRoles.PARAMETERS_ROLE;
        bool reserveWired = manager.getTargetFunctionRole(address(reserve), KeelsonReserve.setCooldown.selector)
            == KeelsonRoles.PARAMETERS_ROLE;
        if (vaultWired && reserveWired) return (vault, reserve, time);
        bytes32 vaultSalt = _salt("KeelsonBondVault/roles");
        bytes32 reserveSalt = _salt("KeelsonReserve/roles");
        if (!vaultWired) {
            vm.prank(MedusaFork.PROPOSER);
            timelock.scheduleBatch(targets, values, payloads, bytes32(0), vaultSalt, delay);
        }
        if (!reserveWired) {
            vm.prank(MedusaFork.PROPOSER);
            timelock.schedule(address(manager), 0, reservePayload, bytes32(0), reserveSalt, delay);
        }
        wiredAt = time + delay;
        vm.warp(wiredAt);
        if (!vaultWired) timelock.executeBatch(targets, values, payloads, bytes32(0), vaultSalt);
        if (!reserveWired) timelock.execute(address(manager), 0, reservePayload, bytes32(0), reserveSalt);
    }

    /// @dev `VerdictSigners._store`: an active signer of `teeKind` under `measurement`, valid from `validFrom`.
    function _installSigner(
        IVerdictVerifier verifier,
        address signer,
        uint8 teeKind,
        bytes32 measurement,
        uint256 validFrom
    ) internal {
        uint256 id = uint256(vm.load(address(verifier), keccak256(abi.encode(measurement, MEASUREMENT_IDS_SLOT))));
        require(id != 0, "measurement registered");
        bytes32 slot = keccak256(abi.encode(signer, SIGNERS_SLOT));
        uint256 packed = uint256(teeKind) | validFrom << 8 | uint256(type(uint40).max) << 48 | id << 128;
        vm.store(address(verifier), slot, bytes32(packed));
        vm.store(address(verifier), bytes32(uint256(slot) + 1), measurement);
    }

    function _salt(string memory name) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(MedusaFork.RELEASE, "/", name));
    }
}
