-- Candidate-facing job descriptions. spec_md stays the short role spec the AI interviewer reads to
-- match CV claims to the role (lib/interview/plan.ts), so the long, conversational job description
-- gets its own column and never changes interview behaviour. Admins edit both at /admin/roles.
-- Format: the small markdown subset in lib/markdown.ts (## / ### headings, - and 1. lists, **bold**).

alter table public.roles
  add column jd_md text not null default '' check (char_length(jd_md) <= 20000);

update public.roles set
summary = 'Sit with clients, find what''s really wrong in their messy data, take a researched position on what to build, then build the first working version with AI tools and hand it to an engineer for production.',
jd_md = $jd$
Most business analyst jobs end with a document. This one ends with something that works.

You'll sit with a client's team, dig through their spreadsheets and system exports, and work out what's really going on. It's often not what they asked about. You'll take a position on what to build and why, back it with research, and then build the first clickable version yourself, with AI tools. When it proves the point, you hand it to one of our software engineers, who takes it to production. Your handoff is what they build from, so it has to be good enough that they don't need to call you.

## What you'll actually do

- **Discovery.** Talk to managers, frontline staff and executives. Ask the question that surfaces the constraint nobody mentioned, then play back what you heard so they can correct you.
- **The data.** Open the client's exports and find what's broken before anyone tells you where to look: duplicates, missing keys, columns that mean different things in different files, numbers that don't add up.
- **A point of view.** Research the world outside the client (regulation, platform rules, benchmarks) and connect it to this business. Then say what they should do, what they shouldn't, and why. We call this a Spiky POV: a position a smart person could disagree with, backed by evidence.
- **The first version.** Build a clickable MVP that runs on the client's data, using AI tools such as Lovable, v0 and Supabase. It doesn't need to be production-grade. It needs to prove what's worth building.
- **The handoff.** Write the pack an engineer builds from: user stories with acceptance criteria they can test, business rules, edge cases, who can see and do what, and what's out of scope.
- **After launch.** Stay with the client on adoption and keep improving what's live.

## You and the engineer

Every project runs as a pair. You prove what to build. A software engineer makes it survive production: security, integrations, deployment, monitoring.

You own the problem and the rules about who can see and do what. They own the guarantees that enforce those rules. The handoff is the contract between you, and it's the thing we care about most on both sides. If they come back with twenty questions, it wasn't finished.

## A day in the job

Days vary. Here's a typical one in the middle of a client engagement.

- **Morning.** A call with the client's operations manager. You came with three questions. The useful answer comes from a fourth, when she mentions that half her team keeps a private spreadsheet "because the system is wrong". You ask to see it.
- **Midday.** You put that spreadsheet next to the system export. The same customer shows up three times under slightly different names, and a big share of the "active" accounts haven't been touched in a year. AI does the first pass of the profiling. You check what it found and decide what it means.
- **Afternoon.** You pressure-test your position. Is the real problem the quality of the leads, or that nobody follows up? You read what the rules allow, look at how others solve it, and write the one-page argument. Then you add a screen to the prototype so the client can watch it work on their own data.
- **End of day.** You update the handoff: two new acceptance criteria, an edge case you found in the data, and a line in "out of scope" so nobody builds the thing you've argued against. You send the engineer a short note on what changed.

## The honest part

- Clients don't always know what they need, and sometimes what they ask for is the wrong thing. You'll have to say so, politely and with evidence.
- Data is never as clean as the sales deck. Expect real time in spreadsheets.
- Some of what you build will be thrown away. That's what a first version is for.
- There's no requirements template to hide behind.

## What great looks like

A strong BA here:

- finds the problem behind the request, and shows the client the evidence in their own data
- writes a point of view an executive can say yes or no to in five minutes
- gets a first version people can click through in days, not weeks
- hands over a pack the engineer can build from without a meeting
- uses AI for the heavy lifting (extraction, drafting, profiling) and can say exactly which parts were the AI's and which were their judgement
- says what not to build, and is usually right

A few months in, success looks like this: you've run discovery on a live client project, your prototype changed what the client decided to build, and an engineer has shipped from your handoff without having to rewrite it.

## This job is for you if

- You'd rather find out what's actually wrong than write down what you're told.
- You like data. You open the spreadsheet before the meeting, and you notice when the numbers don't add up.
- You can tell a senior person "I think that's the wrong problem", and then show them why.
- You already use AI tools every day, and you check what they give you.
- You want to build things, not just describe them, even if you've never called yourself a developer.
- You write clearly: answer first, short, numbers where they matter.
- You want to learn fast on real client work.

## This job is not for you if

- You want a clear spec handed to you. We'll hand you a mess and ask what it means.
- You'd rather not build anything yourself. You don't need to be an engineer, but you will build the first version.
- You prefer to agree with the client. Sometimes the job is telling them no.
- You want to hand over a document and move on. You stay with it until people are using it.
- You don't trust AI tools, or you trust them too much. We need people who use them heavily and check everything.
- You need a senior salary right now. Our band is below the market rate for senior BAs, and we'd rather say so up front.

## Pay and how we work

- **R30,000 to R32,500 a month gross**, plus a year-end profit share. The profit share is discretionary and follows a written policy. There's no equity at this stage.
- **Remote within South Africa.**
- What comes with a salary below senior rates: real client systems from your first week, an AI-native way of working, a share of the profit, and room for your pay to grow as client revenue grows.
- "AI-native" describes how you work, not your age or how long you've been working. If you use AI tools to go faster and you check their work, you're who we mean.

## How we hire

Everything happens on this site, and you see your result after every stage.

1. **Create an account and upload your CV.** You'll read our privacy notice first.
2. **Reasoning Assessment.** 30 questions in 15 minutes.
3. **AI CV interview.** A spoken conversation of about 25 to 30 minutes about your own CV: what you did, how you did it, and what happened.
4. **Role quiz.** 15 questions in 12 minutes.
5. **Discovery and point of view.** You interview a simulated client stakeholder, find the gaps in their data and write your point of view. About 3 hours of work in a 4-hour window, which you start when you're ready.
6. **Build and handoff.** You build the first version and write the handoff pack. About 4 hours of work in a 48-hour window.
7. **Live session.** If you're shortlisted, you meet our team: an interview, a conversation about your work, and a short live exercise.

People make every hiring decision, not software, and you can ask a person to review any score. If you need an adjustment, such as typing your interview answers because you can't use a microphone, ask before that stage and we'll set it up. We never use your work commercially, and you keep the copyright.

## If this sounds like you

Apply. Setting up your account, uploading your CV and doing the Reasoning Assessment takes about half an hour, and you can come back for the rest.

If you've read this far thinking "finally, a BA job where I get to build the thing", we'd like to meet you.
$jd$
where slug = 'business-analyst';

update public.roles set
summary = 'Take the first working version a business analyst built with AI tools and make it production-grade: secure, tested, integrated, deployed and running. Then design and cost the bigger systems before we sell them.',
jd_md = $jd$
Our business analysts build the first version of a client's system with AI tools, quickly. It works on their laptop and proves the idea. Your job is to make it something a client can rely on.

That means reading code you didn't write, finding what will break before it breaks, fixing what matters first, and putting it into production in our cloud or the client's. You'll also design and cost bigger systems before we sell them, and explain your thinking to people who don't write code.

## What you'll actually do

- **Harden.** Take a working prototype and its handoff pack, read both properly, and make it production-grade: access rules enforced in the database, migrations, secrets handled properly, tests, CI, error monitoring and a way to roll back.
- **Build the data plumbing.** Clients send messy exports. You build imports that can run twice without doubling anything, clean what they can, set aside what they can't, and fail loudly when the file changes shape.
- **Implement the handoff.** Build the stories to their acceptance criteria. When the handoff is unclear or wrong, you take it up with the BA.
- **Ship it and run it.** Deploy, keep it healthy, and write release notes the client understands.
- **Design and cost bigger systems.** Before we sell something big, you work out how it should be built, what to buy instead of build, what it will cost a month in rands, what could go wrong and what we shouldn't promise.
- **Explain it.** Write a one-page summary a CEO can decide from.

Our stack: TypeScript, Next.js, Vercel, Supabase (Postgres) and OpenRouter.

## You and the BA

Every project runs as a pair. The BA proves what to build: they run discovery, find the gaps in the client's data, take a position and build the first clickable version. You make it survive production.

They own the problem and the rules about who can see and do what. You own the guarantees that enforce those rules. The handoff is the contract between you: read it properly, build to it, and tell the BA when it's wrong, because sometimes it will be. And treat the prototype with respect. It isn't a mess to rewrite; it's proof of what the client needs.

## A day in the job

Days vary. Here's a typical one in the middle of a client engagement.

- **Morning.** A BA's prototype has just come over with its handoff pack, and the client wants it live. You read the handoff first, then the code, and keep a list. By mid-morning the list has a permissions gap, a setting that shouldn't be in the code and an important calculation with no tests around it.
- **Midday.** You fix the worst one first and write the test that would have caught it. AI drafts the migration; you read every line before it goes near the database.
- **Afternoon.** A call with the BA. The handoff says managers can see everything, but the client has just told them regional managers should only see their own region. You agree the rule together and enforce it in the database, not just on the screen. Then you get the import ready for the client's next export, which won't look exactly like this one.
- **End of day.** Deploy to staging, check the health check and the error monitor, and write three lines of release notes the client's operations manager will actually understand.

Some days look different: a whole day on an architecture and cost plan for something we're about to propose, or a session at a client's office.

## The honest part

- Most of what you work on starts as someone else's prototype, and some of it was written quickly by AI.
- You own what you ship: deploying it, watching it and fixing it when it breaks.
- Clients change their minds and their data. Your systems have to cope with both.
- You'll explain technical risk to people who care about what it costs them, not how it works.

## What great looks like

A strong engineer here:

- finds the problems in a prototype without being told where to look, and fixes the ones that matter first
- ships one thing that works rather than five that demo
- builds imports that can be re-run safely and that fail loudly when the data changes
- deploys with CI, a health check, error monitoring and a written way to roll back
- uses AI tools heavily, checks everything they produce, and can explain every line they ship without AI
- costs a system in rands with the assumptions written down, and tells the client what the budget won't buy
- can put the whole thing on one page for a CEO

A few months in, success looks like this: a prototype you hardened is live with a real client and stays up, you've written an architecture and cost plan we used in a proposal, and the BAs you work with trust your feedback on their handoffs.

## This job is for you if

- You're a full-stack builder who's comfortable in TypeScript and Postgres.
- You'd rather ship one thing that works than five that demo.
- You use AI tools every day, and you verify what they produce.
- You enjoy making someone else's working idea solid, not only starting from a blank page.
- You care about security and data handling because you know what happens when they go wrong.
- You can explain a trade-off to a non-technical executive in plain language, with numbers.
- You want real production responsibility early.

## This job is not for you if

- You only want greenfield work. Most of what you touch starts as someone else's prototype.
- You'd rather rewrite than understand. We need people who can read a codebase and fix what matters.
- You want a spec that never changes. Client needs and client data both move.
- You won't use AI tools, or you use them without checking. Both are a problem here.
- You'd rather not talk to clients. You'll explain your work to their executives.
- You need a senior salary right now. Our band is below the market median for senior engineers, and we'd rather say so up front.

## Pay and how we work

- **R30,000 to R32,500 a month gross**, plus a year-end profit share. The profit share is discretionary and follows a written policy. There's no equity at this stage.
- **Remote within South Africa.** Cape Town or Johannesburg is preferred, because some client sessions are in person.
- What comes with a salary below senior rates: production responsibility on real client systems from your first week, an AI-native way of working, a share of the profit, and room for your pay to grow as client revenue grows.
- "AI-native" describes how you work, not your age or career stage. If you use AI to go faster and you verify what it gives you, you're who we mean.

## How we hire

Everything happens on this site, and you see your result after every stage.

1. **Create an account and upload your CV.** You'll read our privacy notice first.
2. **Reasoning Assessment.** 30 questions in 15 minutes.
3. **AI CV interview.** A spoken conversation of about 25 to 30 minutes about your own CV: what you built, how, and what happened.
4. **Role quiz.** 15 questions in 12 minutes.
5. **Harden and ship.** You get a BA's prototype, its handoff pack and a client data export. Make it production-ready and deploy it. About 6 hours of focused work in a 72-hour window, so people with jobs and families can take part. Use any AI tools you like.
6. **Architecture and cost plan.** A written plan and cost model for a bigger system, plus a 5-minute video for a non-technical CEO. About 3 to 4 hours of work in a 24-hour window.
7. **Live session.** If you're shortlisted, you meet our team: an interview and a conversation about your work, including some debugging without AI.

People make every hiring decision, not software, and you can ask a person to review any score. If you need an adjustment, such as typing your interview answers because you can't use a microphone, ask before that stage and we'll set it up. We never use your work commercially, and you keep the copyright.

## If this sounds like you

Apply. Setting up your account, uploading your CV and doing the Reasoning Assessment takes about half an hour, and you can come back for the rest.

If you read "make someone else's prototype production-grade" and thought "that's my favourite kind of work", we'd like to meet you.
$jd$
where slug = 'software-engineer';
