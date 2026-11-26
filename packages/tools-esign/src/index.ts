/**
 * @officehum/tools-esign — the portable e-signature pack.
 *
 * One interface (`ESignature`) for whichever provider a business uses, a fake for tests, and the
 * tools a role uses to send documents for signature behind an approval that always asks, follow
 * them, save the signed copy and void a request. It depends on Pi Durable and pi-ai (peers) and the
 * SDK, never on a host, so the same pack runs in a bare Pi Durable harness. See
 * README.md.
 */

export {
  type ApprovalDependencies,
  approvedNow,
  esignApprovalFacts,
  MAX_DOCUMENTS,
  MAX_SIGNERS,
  readSendFacts,
  readVoidFacts,
  SEND_APPROVAL,
  type SendFacts,
  sendSummary,
  VOID_APPROVAL,
  type VoidFacts,
} from "./approvals.js";
export {
  ESIGN_POLICY_VERSION,
  type SaveSignedOptions,
  type SignedCopy,
  saveSigned,
} from "./download.js";
export {
  checkEvent,
  checkSendResult,
  checkStatusResult,
  ESIGN_ERROR_CODES,
  ESIGN_STATUSES,
  type ESignature,
  type ESignCompleted,
  type ESignDocument,
  ESignError,
  type ESignErrorCode,
  type ESignEvent,
  type ESignSendRequest,
  type ESignSendResult,
  type ESignSigner,
  type ESignSignerState,
  type ESignStatus,
  type ESignStatusResult,
  type ESignTemplate,
  type ESignWebhookRequest,
  isPdf,
  SIGNER_STATUSES,
  type SignerStatus,
} from "./esign.js";
export {
  FAKE_SIGNATURE_HEADER,
  type FakeESignature,
  type FakeESignatureOptions,
  type FakeRequest,
  fakeESignature,
} from "./fake.js";
export {
  type ApprovedDocument,
  type ApprovedSigner,
  type ApprovedTemplate,
  ESIGN_REQUESTS_DOC,
  type ESignRecord,
  type ESignRecords,
  recordForProvider,
  signedBaseName,
} from "./records.js";
export {
  ESIGN_DOWNLOAD,
  ESIGN_PACK_ID,
  ESIGN_SEND,
  ESIGN_STATUS,
  ESIGN_TEMPLATES,
  ESIGN_VOID,
  type ESignPack,
  type ESignPackOptions,
  eSignaturePack,
} from "./tools.js";
