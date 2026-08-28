// Public library surface — import from 'ccip-router' in downstream projects
export { CcipRouter } from './router/index.js'
export type { ResolverFn, CcipRouterOptions, IdentityOpts } from './router/CcipRouter.js'
export { withWyriwe } from './attestation/withWyriwe.js'
export type { WyriweOpts } from './attestation/withWyriwe.js'
export type { DB, MeshRecord, PeerState } from './db/types.js'
export { publishAttestation, checkOnChain } from './chain/publish.js'
export type { ChainOpts, PublishResult, OnChainProof } from './chain/publish.js'
export { registerNode } from './chain/register.js'
export { ATTESTATION_INDEX_ABI, NODE_REGISTRY_ABI, WYRIWE_PROOF_VERIFIER_ABI, WYRIWE_ATTESTATION_VERIFIER_ABI } from './chain/abi.js'
export { makeVni, verifyVni, fetchPeerVni } from './mesh/vni.js'
export type { SignedVni, VniDocument } from './mesh/vni.js'
export { withEns, isEnsCalldata } from './ens/withEns.js'
export type { EnsResolverFn, EnsRecord } from './ens/withEns.js'
export { encodeDnsName, decodeDnsName } from './ens/dns.js'
export {
  inspectTseiPublicReceipt,
  makeUnsignedTseiProfileAObservation,
  signTseiProfileAObservation,
  toTseiProfileAAttestation,
  TSEI_PROFILE_A_INPUT_DOMAIN,
  TSEI_PROFILE_A_NAMESPACE,
  TSEI_PROFILE_A_VANTAGE_CLASS,
} from './integrations/tseiProfileA.js'
export type { TseiProfileAAttestation, TseiReceiptInspection } from './integrations/tseiProfileA.js'
