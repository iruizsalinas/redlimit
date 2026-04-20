# Contributing

Thanks for wanting to help out. Here's what you need to know.

## Setup

```bash
git clone https://github.com/iruizsalinas/redlimit.git
cd redlimit
npm install
```

You'll need a local Redis instance running for integration tests. Default is `redis://localhost:6379` (set `REDIS_URL` in `.env` to change it).

## Development

```bash
npm run lint              # type check
npm run test:unit         # fast, no Redis needed
npm run test:integration  # needs Redis
npm test                  # everything
```

## Submitting changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Make sure `npm run lint` and `npm test` both pass
4. Open a pull request

Keep PRs focused on one thing. If you're fixing a bug and also want to refactor something nearby, split them into separate PRs.

## Lua scripts

The rate limiting logic runs as atomic Lua scripts inside Redis. If you're modifying an algorithm, make sure to test it under concurrency. Check out `test/integration/concurrency.test.ts` for that.

## Questions?

Open an issue. No question is too small.
