# Run the CLI directly from TypeScript for the fastest development loop.
dev *args:
    ./pi-test.sh {{args}}

# Build all packages and replace the globally available pi command with this fork.
install:
    ./scripts/install-fork.sh
