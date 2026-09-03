import { defineConfig } from 'vitest/config';

// Only this project's tests: without the include, vitest also walks the
// agent worktrees under .claude/worktrees and runs every copy it finds.
export default defineConfig({
  test: { include: ['test/**/*.test.js'] },
});
