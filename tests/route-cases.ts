/**
 * Prompts labelled by what the person wants done, written before the router and not tuned to it.
 * `[prompt, role, other acceptable roles]`: a prompt that two roles can honestly serve lists the second one.
 * "none" means a follow-up or a remark that is not a new task, where no role should be injected.
 */
export type Expected = "autopilot" | "reader" | "analyser" | "extractor" | "writer" | "fixer" | "reviewer" | "none";
export type Case = [prompt: string, role: Expected, also?: Expected[]];

export const WRITER: Case[] = [
  ["create a new file src/utils/slugify.ts that exports a slugify function", "writer"],
  ["Add a new folder called services and put an email service in it", "writer"],
  ["I need a new endpoint POST /api/orders that saves an order", "writer"],
  ["make a login page component with email and password fields", "writer"],
  ["write a unit test for the tax calculator", "writer"],
  ["scaffold a new React component named UserCard", "writer"],
  ["add pagination to the products list", "writer"],
  ["implement retry with exponential backoff in the http client", "writer"],
  ["creaet a new python script to export users to csv", "writer"],
  ["Add a dark mode toggle to the settings screen", "writer"],
  ["generate a README for this project", "writer"],
  ["build a cli command 'doctor' that checks the setup", "writer"],
  ["can you add a new class InvoiceMailer", "writer"],
  ["make a new file called notes.md in docs", "writer"],
];

export const FIXER: Case[] = [
  ["fix the failing test in tests/tax.test.ts", "fixer"],
  ["I'm getting TypeError: Cannot read properties of undefined (reading 'id') when I open the cart", "fixer"],
  ["the build is broken, error TS2322 in src/api.ts, please fix", "fixer"],
  ["login doesn't work anymore after the last merge", "fixer"],
  ["Bug: the total is wrong when the discount is 100%", "fixer"],
  ["npm test fails with ENOENT, can you debug it", "fixer"],
  ["the app crashes on startup with a null pointer exception", "fixer"],
  ["the date picker shows the wrong month, fix this", "fixer"],
  ["pytest is red: AssertionError in test_orders.py::test_total", "fixer"],
  ["there is a memory leak in the worker, find and fix it", "fixer"],
  ["chnage the timeout bug in uploader, it hangs forever", "fixer"],
  ['Traceback (most recent call last):\n  File "app.py", line 3, in <module>\n    user = data["user"]\nKeyError: \'user\'', "fixer"],
  ["why is my pipeline failing? fix it", "fixer"],
  ["the checkout button does nothing when I click it", "fixer"],
];

export const READER: Case[] = [
  ["explain how authentication works in this project", "reader"],
  ["where is the retry logic implemented?", "reader"],
  ["what does the gate_check function do", "reader"],
  ["read the src/gate folder and tell me what each file is for", "reader"],
  ["show me how a request flows from the router to the database", "reader"],
  ["which files call createInvoice?", "reader"],
  ["walk me through the build process", "reader"],
  ["what is in the tests folder", "reader"],
  ["summarize this repo", "reader"],
  ["how does the cache invalidation work", "reader"],
  ["find where the config is loaded", "reader"],
  ["can you tell me what this regex in parse.ts does", "reader"],
  ["list all the API endpoints", "reader"],
  ["I want to understand the payment module", "reader"],
  ["explain how to fix this error, don't change anything yet", "reader"],
  ["just read the file and tell me, do not edit it", "reader"],
];

export const ANALYSER: Case[] = [
  ["should we use a queue or a cron job for sending the reports?", "analyser"],
  ["what would break if I rename the User table?", "analyser"],
  ["compare the two approaches for caching: in-memory vs redis", "analyser"],
  ["how risky is changing the pricing function", "analyser"],
  ["estimate how big a change it is to add multi-tenant support", "analyser"],
  ["what is the blast radius of editing config.ts", "analyser"],
  ["which approach is safest for upgrading the ORM", "analyser"],
  ["pros and cons of splitting the monolith", "analyser"],
  ["which tests would I need to run if I change auth.ts", "analyser"],
  ["is it safe to delete the legacy folder?", "analyser"],
  ["what are my options to make the search faster", "analyser"],
  ["how hard would it be to support Postgres as well as MySQL", "analyser"],
];

export const EXTRACTOR: Case[] = [
  ["refactor the order processing code into smaller functions", "extractor"],
  ["move the validation helpers from utils.ts into their own module", "extractor"],
  ["split the 2000 line app.ts into separate files", "extractor"],
  ["extract the email sending logic into a service without changing behaviour", "extractor"],
  ["rename the function getUser to fetchUser everywhere", "extractor"],
  ["remove the duplicate code between billing and invoicing", "extractor"],
  ["clean up the folder structure of src/components", "extractor"],
  ["pull the constants out of main.py into constants.py", "extractor"],
  ["reorganize the tests folder to mirror src", "extractor"],
  ["decouple the controller from the database layer", "extractor"],
  ["inline the tiny helper and delete the file", "extractor"],
  ["restructure the project into packages", "extractor"],
];

export const REVIEWER: Case[] = [
  ["review my changes before I commit", "reviewer"],
  ["can you do a code review of PR 142", "reviewer"],
  ["look over this diff and tell me if anything is wrong", "reviewer"],
  ["check my branch against main for problems", "reviewer"],
  ["review the last commit", "reviewer"],
  ["what do you think about this pull request?", "reviewer"],
  ["audit the changes in src/auth for security issues", "reviewer"],
  ["give me feedback on my uncommitted changes", "reviewer"],
  ["do a PR review for the feature/payments branch", "reviewer"],
  ["is my change okay to merge? check the diff", "reviewer"],
];

export const AUTOPILOT: Case[] = [
  ["implement the whole export feature end to end, tests included, and handle whatever comes up", "autopilot", ["writer"]],
  ["take care of this ticket: add CSV export and fix the date bug in reports", "autopilot"],
  ["do everything needed to upgrade to React 19", "autopilot"],
  ["just do it, I trust you", "autopilot", ["none"]],
  ["complete this task start to finish: add rate limiting and update the docs", "autopilot", ["writer"]],
  ["I have a few things: add a cache, fix the flaky login test, and tidy up the config", "autopilot"],
  ["autopilot: migrate from moment to date-fns", "autopilot"],
  ["build the new dashboard from scratch and make sure everything still passes", "autopilot", ["writer"]],
];

/** Both readings are fair: a question about a failure may want an explanation or a fix. */
export const AMBIGUOUS: Case[] = [
  ["why is the build failing?", "fixer", ["reader"]],
  ["why does the login fail for new users?", "fixer", ["reader"]],
  ["what is wrong with this function?", "fixer", ["reader", "reviewer"]],
  ["can you look at the checkout code", "reader", ["reviewer", "fixer"]],
  ["improve the performance of the report page", "fixer", ["extractor", "writer", "analyser", "autopilot"]],
  ["update the docs to mention the new flag", "writer", ["fixer"]],
  ["add error handling to the uploader", "writer", ["fixer"]],
  ["how do I add a new route here?", "reader", ["writer", "analyser"]],
];

export const NONE: Case[] = [
  ["thanks", "none"],
  ["yes", "none"],
  ["ok go ahead", "none"],
  ["continue", "none"],
  ["Yes, start", "none"],
  ["DO the next further things", "none"],
  ["commit this", "none"],
  ["push it", "none"],
  ["hi", "none"],
  ["looks good", "none"],
  ["/compact", "none"],
  ["yes please do that", "none"],
];

export const SET_A: Case[] = [...WRITER, ...FIXER, ...READER, ...ANALYSER, ...EXTRACTOR, ...REVIEWER, ...AUTOPILOT, ...AMBIGUOUS, ...NONE];

/**
 * A fourth set in other styles (issue titles, commit-message style, chatty narrative, Stack Overflow style), written
 * after the router was tuned on A, B and D and measured once, with nothing changed for it afterwards.
 */
export const SET_E: Case[] = [
  ["Bug: pagination returns the same page twice when sorting by date", "fixer"],
  ["Feature request: export the audit log as JSON", "writer"],
  ["Fix: crash when the config file is empty", "fixer"],
  ["feat: add rate limiting middleware to the public API", "writer"],
  ["refactor: extract token parsing from auth.py", "extractor"],
  ["Docs: explain how to run the integration tests locally", "writer", ["reader"]],
  ["So I've been looking at our order flow and honestly it feels brittle. Can you tell me how orders get created from the cart to the database?", "reader"],
  ["Hey! Quick one: the profile page keeps showing the old avatar after I upload a new one. Any idea what's wrong? Would love a fix.", "fixer"],
  ["We're debating Kafka versus RabbitMQ for the events service, what would you pick and why?", "analyser"],
  ["I have to estimate this for planning tomorrow: how many files would we touch to switch the logging library?", "analyser"],
  ["How do I loop over a dict in Python?", "reader", ["analyser"]],
  ["Why does my React component re-render on every keystroke?", "reader", ["fixer", "analyser"]],
  ["Is there a way to make the build faster without upgrading the CI machine?", "analyser", ["reader"]],
  ["Please create an empty __init__.py in every package folder that lacks one", "writer"],
  ["Make a CHANGELOG.md following keep-a-changelog and fill it from the git history", "writer"],
  ["Add input validation to the signup handler and write tests for it", "writer"],
  ["The deploy script silently skips the migrations step if the DB is slow, can you make it fail loudly instead?", "fixer", ["writer"]],
  ["Break out the email templates from mailer.js into their own folder", "extractor"],
  ["Rename the 'utils' directory to 'shared' and update every import that points at it", "extractor"],
  ["Consolidate the config loading, there are four slightly different versions of it", "extractor"],
  ["Look through my last few commits and tell me if I introduced any regressions", "reviewer"],
  ["Pretend you're a strict reviewer and go over the changes in src/payments", "reviewer"],
  ["Here's my PR description and diff. Is there anything I missed?", "reviewer"],
  ["Please take the whole analytics dashboard task from design to finished, tests and docs included", "autopilot"],
  ["I need you to upgrade Django to 5, run the tests and sort out whatever fails", "autopilot"],
  ["Add dark mode and fix the sidebar overflow on small screens", "autopilot"],
  ["Who owns the billing module and what does it depend on?", "reader"],
  ["Show me where the feature flags are defined", "reader"],
  ["Give me a quick summary of what changed in the auth folder recently", "reader", ["reviewer"]],
  ["What breaks if we remove the legacy /v1 endpoints?", "analyser"],
  ["Compare the two caching layers we have and tell me which one to keep", "analyser"],
  ["TypeError: 'NoneType' object is not subscriptable", "fixer"],
  ["it works on my machine but the docker build fails at the pip install step", "fixer"],
  ["ok", "none"],
  ["alright, let's do it", "none"],
  ["not now", "none"],
  ["you can merge it", "none"],
  ["ah I see, makes sense", "none"],
  ["cancel that", "none"],
  ["thx", "none"],
];

/**
 * A third set, written after the router had been tuned on A and B, and measured once before anything was changed for
 * it. Phrased with other verbs ("wire up", "dig into", "sanity check", "port"). Still the author's own wording.
 */
export const SET_D: Case[] = [
  ["Hook up a /health endpoint that returns the app version", "writer"],
  ["Add support for CSV import on the customers screen", "writer"],
  ["Can you document the public functions in utils.py with docstrings?", "writer"],
  ["Port this bash script to Python", "writer", ["extractor", "autopilot"]],
  ["Wire up the new settings page to the router", "writer"],
  ["Put a retry decorator around the API calls", "writer"],
  ["Spin up a basic Express server with one test route", "writer"],
  ["write a function that validates IBAN numbers", "writer"],

  ["Users in Safari can't upload avatars, the spinner never ends", "fixer"],
  ["FAILED tests/test_cart.py::test_apply_coupon - assert 90.0 == 100.0", "fixer"],
  ["this regex matches too much, tweak it", "fixer", ["writer"]],
  ["CI is failing on the lint step since yesterday", "fixer"],
  ["The nightly job dies with OOM after about ten minutes", "fixer"],
  ["Figure out why the websocket keeps disconnecting and patch it", "fixer"],
  ["dates show up one day early for users in Asia", "fixer"],
  ["uncaught exception in the payment webhook handler, fix please", "fixer"],

  ["Explain this stack: what is Hibernate doing here?", "reader"],
  ["Walk me through the checkout code path", "reader"],
  ["how many services talk to the queue?", "reader"],
  ["What's the difference between the two auth middlewares?", "reader", ["analyser"]],
  ["Show the main entry point and what it wires together", "reader"],
  ["What does the 'retry' config option control?", "reader"],
  ["Find all places where we parse dates", "reader"],
  ["I'm new here, give me a tour of the repo", "reader"],

  ["Which is less risky: patching the library or forking it?", "analyser"],
  ["If I drop the users.legacy_id column what code would be hit?", "analyser"],
  ["Do you think we should adopt TypeScript gradually or all at once?", "analyser"],
  ["Rough effort to move the cron jobs into a queue worker?", "analyser"],
  ["Compare Redux Toolkit and Zustand for this codebase", "analyser"],
  ["Is it ok to change the order of these migrations?", "analyser"],
  ["What are the trade offs of caching at the edge?", "analyser"],

  ["The OrderService is huge. Split off the pricing logic into its own class", "extractor"],
  ["Make this code DRY: the three validators are nearly the same", "extractor"],
  ["Convert all the callbacks in db.js to async/await without changing behaviour", "extractor"],
  ["Rename userId to accountId across the repo", "extractor"],
  ["Move the CSS out of the components into a styles folder", "extractor"],
  ["Reorganise src by feature rather than by type", "extractor"],
  ["Pull the magic numbers into named constants", "extractor"],

  ["Sanity check my PR before I ask for reviews", "reviewer"],
  ["Could you go through the diff against main and flag risky parts?", "reviewer"],
  ["Double-check the migration script I just wrote for mistakes", "reviewer", ["fixer"]],
  ["review the staged changes", "reviewer"],
  ["any problems with how I handled errors in this commit?", "reviewer"],
  ["give this patch a once-over", "reviewer"],

  ["Here is the ticket: customers want to download invoices as PDF. Make it happen.", "autopilot", ["writer"]],
  ["Rework the onboarding flow completely and don't stop until the tests are green", "autopilot"],
  ["Migrate the project from JavaScript to TypeScript, whole thing", "autopilot"],
  ["Can you just handle the release notes, version bump and changelog for 2.0?", "autopilot", ["writer"]],
  ["Fix the broken login and also add 2FA", "autopilot"],
  ["Clean up the repo and update all dependencies and fix whatever breaks", "autopilot"],

  ["Why is the homepage slow?", "analyser", ["reader", "fixer"]],
  ["Can you look at the auth code and tell me if it's secure?", "reviewer", ["reader", "analyser"]],
  ["update the dependencies", "autopilot", ["writer"]],
  ["how would you test this module?", "analyser", ["reader", "writer"]],
  ["the logging is a mess", "extractor", ["fixer", "autopilot", "writer", "analyser", "none"]],

  ["perfect", "none"],
  ["yep do it", "none"],
  ["thanks, that's all for now", "none"],
  ["undo that", "none", ["autopilot"]],
  ["sorry, I meant the other file", "none"],
  ["let's continue tomorrow", "none"],
  ["good morning", "none"],
];

/**
 * A second set, written after the rules and phrased differently (polite, long, pasted errors). Still written by the
 * person who wrote the rules, so it says how the router copes with new wording, not how it does on real users.
 */
export const SET_B: Case[] = [
  ["Could you please put together a script that backs up the database every night?", "writer"],
  ["I want a new page in the admin area that lists all users", "writer"],
  ["we need an API route for deleting comments", "writer"],
  ["Write tests for the shopping cart module", "writer"],
  ["Create folder structure for a new microservice called billing-api", "writer"],
  ["Please implement the forgot password flow", "writer"],
  ["add a --verbose flag to the CLI", "writer"],
  ["Update the README to document the new --verbose flag", "writer", ["fixer"]],
  ["Make a helper that converts snake_case keys to camelCase", "writer"],
  ["can u make a component for showing toast messages", "writer"],

  ["The signup form throws a 500 whenever the email has a plus sign in it.", "fixer"],
  ["Jest says: Expected: 200, Received: 404 in orders.spec.ts. Please sort this out", "fixer"],
  ["after upgrading node the install step fails with gyp errors", "fixer"],
  ["Something is off with the invoice totals, they are 1 cent too low sometimes", "fixer", ["reader"]],
  ["my build is red again", "fixer"],
  ["pls fix the flaky e2e test, it passes locally but fails on CI", "fixer"],
  ["images are not loading on the product page anymore", "fixer"],
  ["There's an infinite loop in the retry code. Can you track it down and repair it?", "fixer"],
  ["Why does npm run lint hang forever? needs fixing", "fixer"],
  ["ValueError: invalid literal for int() with base 10: 'abc'", "fixer"],

  ["What's the purpose of the middleware folder?", "reader"],
  ["Can you explain what happens when a user logs in?", "reader"],
  ["Where do we validate the JWT?", "reader"],
  ["give me an overview of the database layer", "reader"],
  ["who calls sendEmail", "reader"],
  ["How are the environment variables loaded?", "reader"],
  ["Describe the folder structure", "reader"],
  ["which module is responsible for pricing?", "reader"],
  ["I'd like to understand how the scheduler picks the next job", "reader"],

  ["Is it worth migrating from REST to GraphQL for this app?", "analyser", ["autopilot"]],
  ["What would be affected if I change the signature of parseConfig?", "analyser"],
  ["Should the cache live in the service or the repository?", "analyser"],
  ["How much work is it to add i18n?", "analyser"],
  ["Weigh up using SQLite versus Postgres for the tests", "analyser", ["reader"]],
  ["what's the safest way to roll out this schema change", "analyser"],
  ["Can we remove the legacy API without breaking mobile clients?", "analyser"],
  ["what are the risks of upgrading webpack", "analyser"],

  ["Break the giant Dashboard component into smaller ones, keeping everything working the same", "extractor"],
  ["Move all the date utilities to a shared package", "extractor"],
  ["Rename the module 'helpers' to 'common' and fix all imports", "extractor"],
  ["Consolidate the three copies of the retry function into one", "extractor"],
  ["Separate the parsing code from the network code in client.py", "extractor"],
  ["Tidy up the imports and move the types to their own file", "extractor"],
  ["Get rid of the duplication between the two report generators", "extractor"],
  ["extract an interface from the PaymentGateway class", "extractor"],

  ["Please review PR #88", "reviewer"],
  ["Take a look at my diff and point out issues", "reviewer"],
  ["Anything wrong with the changes on this branch before I open a pull request?", "reviewer"],
  ["do a security review of the login handler changes", "reviewer"],
  ["can you critique my latest commit", "reviewer"],
  ["Review what I changed in the last two commits", "reviewer"],

  ["Handle the whole Stripe integration: webhooks, tests, docs, everything", "autopilot", ["writer"]],
  ["Take this issue and run with it until it is done: users can't export reports, and we also want a CSV option", "autopilot", ["fixer"]],
  ["Do the migration from Jest to Vitest, end to end", "autopilot"],
  ["I'm going away for the weekend, just get the checkout redesign finished and ask me only if you're stuck", "autopilot", ["writer"]],
  ["Go through the backlog item: dark mode toggle plus the broken avatar upload", "autopilot"],
  ["implement SSO and fix the session timeout bug", "autopilot"],

  ["can you check the payments code?", "reader", ["reviewer", "fixer", "analyser"]],
  ["make the search faster", "writer", ["fixer", "extractor", "analyser", "autopilot"]],
  ["look into why signups dropped", "reader", ["fixer", "analyser"]],
  ["what do you think about moving to a monorepo?", "analyser", ["reader"]],
  ["Does this function handle null input?", "reader", ["reviewer", "fixer"]],
  ["improve the error messages", "writer", ["fixer", "autopilot"]],

  ["great, thanks!", "none"],
  ["no", "none"],
  ["go for option 2", "none"],
  ["sounds good, proceed", "none"],
  ["stop", "none"],
  ["wait, not that one", "none"],
  ["ok commit it with a short message", "none"],
  ["what time is it in Tokyo?", "none"],
];
