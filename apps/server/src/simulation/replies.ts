/**
 * Scripted chat replies of the simulated workstation (`AOM_MOCK_REPLIES_FILE` of its runner; format: apps/runner
 * `scriptedReply`). They make a simulation organization feel alive without a model: plain, professional answers for
 * the BA, builders, reviewers, testers and the DevOps engineer, and they never claim that real code was written or
 * deployed outside the simulation. Data only.
 *
 * How it is matched: keys are tried in file order and the first pattern that matches the message wins, so the specific
 * topics come first and the generic ones last. Every value is a list of alternatives; one is picked from the message
 * text, so the same words always get the same answer and different words vary. The map is shared by all agents of the
 * organization (the runner passes only the agent's name), so each answer is phrased to read well from any role.
 * Placeholders: `{name}` is the agent, `{message}` what the user wrote.
 */
export const SIMULATION_REPLIES: Record<string, string | string[]> = {
  // ------------------------------------------------------------------------------------------------ greetings
  '/^\\s*(hi|hello|hey|hiya|howdy|good (morning|afternoon|evening))\\b/i': [
    'Hi! {name} here. Tell me what you would like to look at today: the board, a requirement, or a card in progress.',
    'Hello! I have the board in front of me. What shall we pick up first?',
    'Good to hear from you. Ask me about status, scope, tests or the next piece of work and I will take it from there.',
    'Hi there. I am ready when you are. We can go through the open cards, or start on something new.',
  ],
  '/\\b(who are you|what.?s| is your (name|role|job)|introduce yourself|tell me about yourself)\\b/i': [
    'I am {name}, one of the agents on this team. In this simulation I answer with prepared replies, but the board, the cards and the desk all behave the way they do in a real organization.',
    '{name} here. I work through the cards assigned to me and raise questions on the desk when I need a decision. My chat answers in this simulation are scripted, so treat them as a walkthrough rather than real work.',
  ],

  // ------------------------------------------------------------------------------------------------ business analyst
  '/\\b(acceptance criteria|definition of done|done when|how will we know)\\b/i': [
    'I like to write acceptance criteria as short, testable statements. For example: "A signed-in user can see their orders, newest first", "An empty list shows a helpful message", and "A failed load shows an error with a retry action". Each one becomes a check the tester can run. Which feature should I write them for?',
    'Good acceptance criteria say what the user can do, what they see when things go wrong, and what is explicitly out of scope. Give me the feature and I will draft three to six criteria for you to review before any work starts.',
    'For each card I would list: the main success path, the two or three most likely failure paths, any limits (size, speed, permissions), and what we are deliberately not doing yet. That keeps review and testing objective.',
  ],
  '/\\b(requirements?|user stor(y|ies)|spec(ification)?|prd|what (do|does) (the )?(user|customer|client)s? (want|need))\\b/i':
    [
      'To pin the requirements down I would ask five things: who uses this, what problem it solves for them, what they do today instead, what a good outcome looks like, and what must not change. If you answer those, I can turn them into a short list of user stories.',
      'A useful requirement is specific enough to test. Instead of "make search better" we would write "search results appear within two seconds and highlight the matching words". Tell me the area and I will propose wording like that.',
      'I usually split requirements into must-have, should-have and later. The must-haves form the first release; the rest wait on the board as ideas. Shall we sort your list that way?',
      'Before writing stories I want to confirm the goal and the audience. Who is this for, and what would make them say it worked? Once I have that, the stories follow quickly.',
    ],
  '/\\b(scope|out of scope|in scope|scope creep|mvp|minimum viable|first release|phase)\\b/i': [
    'For a first release I would keep the scope to the smallest set of features that lets a real user finish the main task from start to end. Everything else goes on the board as follow-up cards. That keeps the first delivery short and gives you something to react to early.',
    'A good rule of thumb: if removing a feature does not stop the main task from working, it is not part of the first release. I can go through your list and mark each item as in, later, or out.',
    'Scope is easiest to protect when it is written down. I would record what is in, what is explicitly out, and what is parked for later, and share it with everyone who works on the project.',
  ],
  '/\\b(what (should|shall|do) (we|i) (build|do|work on|tackle|start|pick)( next| first)?|next (feature|step|priority)|prioriti[sz]e|priorities|roadmap|backlog)\\b/i':
    [
      'My suggestion for what to build next: first anything that unblocks other cards, then the item users hit most often, then polish. If you tell me which of those matters most this week, I will order the backlog accordingly and put the top three on the board.',
      'I would pick the card with the biggest user benefit for the least effort. Looking at the board, that is usually a small, well-understood change that can go through build, review and test in a day. I can shortlist three candidates and give a one-line reason for each.',
      'Good next steps are the ones that reduce risk early: anything with an external dependency, anything nobody has tried yet, and anything that blocks other work. Want me to rank the open ideas on those three points?',
      'We have a healthy backlog. If I had to choose, I would finish what is already in flight before starting anything new, then take the highest-value item next. I can lay out that order for you.',
    ],
  '/\\b(turn|convert|make|break|split).{0,40}(into|to).{0,20}(cards?|tasks?|tickets?|stories|work items)\\b|\\b(cards? from (this|our|the) (chat|conversation|discussion))\\b/i':
    [
      'Yes. I would take the decisions from this conversation and write one card per deliverable, each with a short title, a goal, acceptance criteria and a rough size. Large items get split so that no card is more than a couple of days of work. Tell me when you are happy with the list and I will create the cards.',
      'I can do that. The usual shape is: one card for each change a user would notice, one for any groundwork it needs, and one for tests or documentation if they are not part of the card itself. I will show you the draft list before anything lands on the board.',
      'Happy to. I will summarise what we agreed, list the cards with their acceptance criteria, flag anything that is still unclear, and then create them once you confirm.',
    ],
  '/\\b(risks?|risky|concerns?|worr(y|ied)|blockers?|what could go wrong|dependenc(y|ies))\\b/i': [
    'The main risks I would track are: unclear requirements (we mitigate by writing acceptance criteria early), dependencies on other cards or outside systems, and work that is bigger than it looks. At the moment nothing is blocked, but I would keep an eye on the cards that wait on a decision from the desk.',
    'Three things to watch: scope growing while work is in flight, decisions waiting too long on the desk, and cards that touch the same area at the same time. None is serious right now. I will raise it on the desk the moment one of them is.',
    'Risk register in short form: low technical risk on the current cards, medium schedule risk if the open desk questions stay unanswered, and some uncertainty about the last requirement we discussed. Answering the desk questions is the quickest way to lower it.',
  ],
  '/\\b(how (long|much time|many days)|estimates?|estimation|effort|story points?|t-?shirt|size)\\b|\\bwhen (will|can|could) (it|this|that|we)\\b|\\b(deadline|eta|timeline|time ?frame|delivery date)\\b/i':
    [
      'As a rough guide: a small change is a few hours end to end, a medium feature one to two days, and a large one three to five days, always including review and test. I can give a firmer number once the acceptance criteria are written.',
      'I estimate in ranges rather than single dates, because review and test time varies. For a typical card I would say "one to two days, most likely tomorrow afternoon". Point me at the card and I will give you a range and what could move it.',
      'It depends on how clear the requirements are. A well-specified card tends to take half a day to build, a few hours to review and a few to test. An unclear one takes longer because we stop to ask questions. Which card do you mean?',
      'Short answer: not today for anything new, but cards already in review or test should finish soon. Tell me which one you are waiting for and I will say where it stands.',
    ],

  // ------------------------------------------------------------------------------------------------ builder, reviewer, tester, DevOps
  '/\\b(working on|busy with|doing right now|doing at the moment|currently|right now|your (task|card|queue)|what are you up to)\\b/i':
    [
      'I am on the next card in my queue: reading the requirements, making the change in a fresh working copy, and writing the tests that go with it. Then I hand it on for review with a short note on what changed and why.',
      'At the moment I am working through the current card. I have read the acceptance criteria, I am checking the surrounding code for conventions, and the next step is the change itself and its tests.',
      'Right now I am picking up the next item from the board. When it is ready I will hand it to the next stage with a summary, so nobody has to ask what was done.',
      'I am in the middle of a review: reading the change, checking it against the acceptance criteria and looking at the tests. I will leave comments on the card with anything that needs another look.',
    ],
  '/\\b(test (results?|run|report|suite|status|coverage)|did (the )?tests? pass|tests? (pass|passed|passing|failed|failing)|green|red build|coverage)\\b/i':
    [
      'The latest test run on the current cards is green: the new tests pass and nothing existing broke. The tester also ran the end-to-end plan on the card that is in test, and so far there are no open findings.',
      'Test results look good. Unit tests pass, the checks on the main branch are green, and the one card in test has completed its plan. If anything fails, the card goes back to the builder with the failing step attached.',
      'All checks are green at the moment. I would still run the full plan before merging anything bigger, since that is where regressions usually show up.',
      'One test was flaky earlier and has been re-run successfully. I have noted it on the card so it is looked at, but it does not block anything.',
    ],
  '/\\b(bug|broken|error|crash(es|ed)?|fails?|failing|not working|doesn.?t work|regression|defect|issue with)\\b/i':
    [
      'Thanks for flagging that. I would reproduce it first, write down the exact steps and what you expected, then add a card for the fix with a test that fails today and passes after the change. Want me to open that card?',
      'That sounds worth a card. The most useful details are the steps to reproduce, the expected result, the actual result, and where it happens. If you can give me those, a builder can pick it up with a clear test plan.',
      'Understood. I will treat it as a bug: reproduce, find the cause, fix it, and add a regression test so it stays fixed. Is it blocking you right now, or can it go in the normal order?',
    ],
  '/\\b(review(er|ing|ed)?s?|code review|pull request|\\bpr\\b|approve[ds]?|changes requested|feedback on)\\b/i':
    [
      'Reviews look at correctness, readability, tests and whether the change does what the card asked. Small changes need one approval, larger ones two. If a reviewer asks for changes, the card goes back to the builder with the reasons attached.',
      'The review queue is short. Each review checks the change against the acceptance criteria, looks for edge cases, and confirms there are tests. Comments are left on the card so the builder can answer them in one place.',
      'Good reviews are specific: what is wrong, why it matters, and a suggestion if there is one. If I find nothing, I say so clearly and approve, so the card does not wait.',
    ],
  '/\\b(deploy(ed|ing|ment)?|release[ds]?|ship(ped|ping)?|production|go live|go-live|rollout|rollback|pipeline|ci\\b|environment|staging|devops|infrastructure)\\b/i':
    [
      'Deployment status: nothing is waiting to go out right now. When a card is merged and its checks pass, DevOps prepares the release, and anything that touches production waits for your approval on the desk before it runs. In this simulation nothing is deployed anywhere real.',
      'The pipeline is healthy and the last checks passed. A release goes through the same steps each time: merge, build, checks, approval for production, then a short watch period afterwards. In the simulation these steps are shown on the board, but no real servers are touched.',
      'Environments are ready. I would prepare the release notes, confirm the checks are green and put the approval on your desk. If something looks wrong afterwards, rolling back is a single step.',
      'From the DevOps side: the working environment is set up, repositories are in place and the checks run on every change. For a production release you will see an approval request first, so nothing goes out without you.',
    ],
  '/\\b(merge[ds]?|merging|branch(es)?|commit(s|ted)?|repo(sitory|sitories)?|git)\\b/i': [
    'Changes are made on a separate working branch for each card and merged only after review and test. Everything here lives in a throwaway repository on this server, so nothing leaves the simulation.',
    'Each card gets its own branch. When it has passed review and test it is merged into the main line, and the working copy is cleaned up. The repositories in this simulation are local and are deleted with the organization.',
  ],

  // ------------------------------------------------------------------------------------------------ project status
  '/\\b(status|progress|update|where are we|how.?s| is| are (it|things|the project|everything|we) (going|doing)|summary|summari[sz]e|report|overview|catch me up)\\b/i':
    [
      'Here is where things stand: the cards in flight are moving. Builds are in progress, two are waiting for review and one is in test. Nothing is blocked, and I will raise anything that changes on the desk.',
      'Steady progress. The current cards are on track, the review queue is short and test has capacity. The only things waiting are questions on the desk, and answering those would speed things up.',
      'Short summary: a few cards done this week, a few in build, a couple waiting for review, and the rest queued behind them. No blockers at the moment and no card has been in the same state for more than a day.',
      'The project is healthy. Work is flowing from build to review to test without a pile-up. I would check the desk next, because a decision there is the most likely thing to slow us down.',
    ],

  // ------------------------------------------------------------------------------------------------ decisions, desk, board
  '/\\b(desk|decisions?|approval|approve|waiting (on|for) me|needs? my|question for me)\\b/i': [
    'The desk is where I put anything that needs your call: decisions, approvals and questions. Open it to see what is waiting. Answering quickly keeps the cards moving, because blocked work stays blocked until you do.',
    'Anything I cannot decide myself goes onto your desk with the options and my recommendation. If you have items waiting there, those are the best place to start.',
  ],
  '/\\b(board|kanban|columns?|sprint|workflow|stages?)\\b/i': [
    'Cards move from the backlog through build, review and test to done. You can follow them on the board; each move is recorded on the card with who did it and why.',
    'The board shows every card and its stage. If a card stays in one stage too long, I will mention it here and on the desk.',
  ],
  '/\\b(cost|costs|budget|spend(ing)?|price|tokens?|usage)\\b/i': [
    'In this simulation nothing real is spent: no model is called and nothing is billed. In a real organization the cost view shows spend per project and per agent, so you can see where the money goes.',
  ],

  // ------------------------------------------------------------------------------------------------ small talk
  '/\\b(thanks|thank you|thx|cheers|great|perfect|awesome|nice one|well done|good job)\\b/i': [
    'You are welcome! Anything else I can pick up?',
    'Glad to help. I will keep an eye on the board and tell you if anything changes.',
    'My pleasure. Let me know what you would like to do next.',
    'Happy to. I will carry on with the current work.',
  ],
  '/\\b(help|what can you do|how do i|how can i|can you)\\b/i': [
    'I can take cards through build, review and test, answer questions about the project, draft requirements and acceptance criteria, estimate work, and raise decisions on the desk when I need you. What would you like to do?',
    'Ask me about status, scope, estimates, risks, tests or deployments, or tell me what you want built and I will help turn it into cards. This is a simulation, so my answers are prepared, but the board and desk work as they do in a real organization.',
  ],
  '/\\b(bye|goodbye|see you|talk later|good night)\\b/i': [
    'Goodbye! The board will be here when you are back.',
    'See you later. I will keep things moving in the meantime.',
  ],

  // ------------------------------------------------------------------------------------------------ default
  '*': [
    '{name} here. I understood: "{message}". In this simulation I answer with prepared replies, but the board, cards and desk behave like the real thing, so try moving a card or answering a desk question.',
    'Noted, thank you. Anything you do on the board, desk and cards works as in a real organization; my chat answers here are scripted. You could ask me for a status, an estimate, the risks or what to build next.',
    'Thanks for the message. I would normally take that away, think it through and come back with a recommendation. Here I can show you a typical answer if you ask about status, scope, acceptance criteria, estimates or deployments.',
    'Understood. To keep the demo moving, you could ask me where the project stands, what to build next, or to turn this conversation into cards.',
    'Got it. I have noted "{message}". Nothing real is built in this simulation, but you can follow how a request like this would travel through the board, review and test.',
  ],
};
