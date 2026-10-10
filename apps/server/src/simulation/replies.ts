/**
 * Scripted chat replies of the simulated workstation (`AOM_MOCK_REPLIES_FILE` of its runner; format: apps/runner
 * `scriptedReply`). They make a simulation organization feel alive without a model: the answers are plausible and
 * calm, never claim to have done real work, and are stable (the same question gets the same answer).
 * Placeholders: `{name}` is the agent, `{message}` what the user wrote.
 */
export const SIMULATION_REPLIES: Record<string, string | string[]> = {
  '/^(hi|hello|hey|good (morning|afternoon|evening))\\b/i': [
    'Hi! {name} here. Ready when you are: tell me what you would like to look at today.',
    'Hello! I have the board in front of me. What shall we pick up?',
  ],
  '/\\b(status|progress|update|where are we|how is it going)\\b/i': [
    'Short version: the cards in flight are moving. Builds are in progress, two are waiting for review and one is in test. Nothing is blocked right now, and I will raise it on the desk if that changes.',
    'Steady progress. The current sprint cards are on track; the review queue is short and test has capacity. I will flag anything that slips.',
  ],
  '/\\b(working on|busy with|doing right now|current(ly)?)\\b/i':
    'I am on the next card in my queue: reading the requirements, then making the change in a fresh working copy, then handing it on for review. I will report as soon as the handoff is written.',
  '/\\b(bug|broken|error|crash|fails?|failing|not working)\\b/i': [
    'Thanks for flagging that. I would reproduce it first, write down the exact steps, then add a card for the fix with a test that fails today and passes after the change. Want me to open that card?',
    'That sounds worth a card. I would capture how to reproduce it and the expected behaviour so a builder can pick it up with a clear test plan.',
  ],
  '/\\b(test|tests|testing|qa|regression)\\b/i':
    'Testing is part of every card: the builder adds tests, the reviewer checks them, and the tester runs the plan end to end before anything is merged. Anything specific you want covered?',
  '/\\b(review|reviewer|code review)\\b/i':
    'Reviews look at correctness, readability and tests. Small changes need one approval, larger ones two. If a reviewer asks for changes the card goes back to the builder with the reasons attached.',
  '/\\b(deploy|release|ship|production|go live)\\b/i':
    'Releases go out when a card is merged and its checks pass. For anything that touches production, DevOps prepares the change and you approve it on the desk before it runs.',
  '/\\b(estimate|how long|when will|deadline|eta)\\b/i':
    'A small card is usually a few hours of work end to end; a larger one a day or two including review and test. I can give a firmer estimate once the requirements are written.',
  '/\\b(thanks|thank you|cheers|great|perfect)\\b/i': [
    'You are welcome! Anything else I can pick up?',
    'Glad to help. I will keep an eye on the board.',
  ],
  '/\\b(help|what can you do|how do i)\\b/i':
    'I can take cards through build, review and test, answer questions about the project, and raise decisions on the desk when I need you. Tell me what you would like to do.',
  '*': [
    '{name} here. Understood: "{message}". In this simulation I answer with prepared replies, but the board, cards and desk behave like the real thing, so try moving a card or answering a desk question.',
    'Noted. Thanks for the message. Everything you do on the board, desk and cards works as in a real organization; my chat answers here are scripted.',
  ],
};
