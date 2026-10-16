/**
 * Public surface of the Pi Durable adapter. Import from here, never from `./office.js` or
 * `@earendil-works/pi-durable` runtime modules.
 */
export {
  type Office,
  type OfficeConversationOptions,
  type OfficeStorage,
  type OfficeSubmitOptions,
  type OpenOfficeOptions,
  openOffice,
  ROOT_CONVERSATION_ID,
  ROOT_KEY,
  readStoredDocument,
} from "./office.js";
export type { OfficeEvent } from "./watch.js";
