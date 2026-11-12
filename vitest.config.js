import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Git worktrees created under .claude/ hold a full copy of the sources:
    // without this, running the tests from the main checkout collects every
    // test file once per worktree.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
