/** Caption fitting for the networks. The functions live in @aom/shared (the web editor shows the same text); this re-exports them for the server. */
export {
  BLUESKY_LIMIT,
  type BlueskyFacet,
  type ComposedCaption,
  captionLength,
  cleanTags,
  composeCaption,
  escapeLittleText,
  fitCaption,
  graphemes,
  X_LIMIT,
  X_URL_LEN,
  xTweetText,
} from '@aom/shared';
