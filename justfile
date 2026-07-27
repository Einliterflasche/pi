# Run the CLI directly from TypeScript for the fastest development loop.
dev *args:
    test -f packages/ai/src/providers/data/.manifest.json || ./node_modules/.bin/tsx packages/ai/scripts/generate-models.ts --strict --data-only
    ./pi-test.sh {{args}}

# Build all packages and replace the globally available pi command with this fork.
install:
    ./scripts/install-fork.sh
