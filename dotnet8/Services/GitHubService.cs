using DbMigrator.Web.Models;
using LibGit2Sharp;

namespace DbMigrator.Web.Services;

public class GitHubService
{
    public void Clone(CodeConfig cfg, string destDir, Action<string>? onProgress)
    {
        Directory.CreateDirectory(destDir);
        onProgress?.Invoke($"Cloning {cfg.RepoUrl}{(string.IsNullOrEmpty(cfg.Branch) ? "" : $" (branch: {cfg.Branch})")}...");

        var options = new CloneOptions
        {
            BranchName = string.IsNullOrEmpty(cfg.Branch) ? null : cfg.Branch,
        };
        options.FetchOptions.Depth = 1;
        options.FetchOptions.CredentialsProvider = (_, _, _) =>
            new UsernamePasswordCredentials { Username = "x-access-token", Password = cfg.Pat ?? "" };

        Repository.Clone(cfg.RepoUrl, destDir, options);
        onProgress?.Invoke("Clone complete");
    }

    public void PushTo(CodeConfig cfg, string srcDir, Action<string>? onProgress)
    {
        if (!Directory.Exists(srcDir)) throw new Exception($"Source dir not found: {srcDir}");

        // Init repo if not already a repo
        if (!Repository.IsValid(srcDir))
        {
            onProgress?.Invoke("Initializing git in extracted code...");
            Repository.Init(srcDir);
        }

        using var repo = new Repository(srcDir);

        // Stage everything
        Commands.Stage(repo, "*");

        // Commit if there are changes (or empty commit if needed)
        var sig = new Signature("DB Migrator", "db-migrator@local", DateTimeOffset.Now);
        var status = repo.RetrieveStatus();
        if (status.IsDirty || !repo.Commits.Any())
        {
            onProgress?.Invoke($"Committing {status.Count()} change(s)...");
            try { repo.Commit("Restored from backup via DB Migrator", sig, sig, new CommitOptions { AllowEmptyCommit = true }); }
            catch (EmptyCommitException) { /* nothing to commit, fine */ }
        }

        // Set/replace remote
        if (repo.Network.Remotes["origin"] != null)
            repo.Network.Remotes.Remove("origin");
        repo.Network.Remotes.Add("origin", cfg.RepoUrl);

        var targetBranch = string.IsNullOrEmpty(cfg.Branch) ? "main" : cfg.Branch;

        // Rename current branch to targetBranch
        var currentBranch = repo.Head;
        if (currentBranch.FriendlyName != targetBranch)
        {
            try { repo.Branches.Rename(currentBranch, targetBranch); } catch { /* fresh repo edge case */ }
        }

        var pushOptions = new PushOptions
        {
            CredentialsProvider = (_, _, _) =>
                new UsernamePasswordCredentials { Username = "x-access-token", Password = cfg.Pat ?? "" }
        };

        onProgress?.Invoke($"Pushing to {cfg.RepoUrl} (branch {targetBranch}, force)...");
        // '+' prefix on refspec = force push
        var refSpec = $"+refs/heads/{targetBranch}:refs/heads/{targetBranch}";
        repo.Network.Push(repo.Network.Remotes["origin"], refSpec, pushOptions);
        onProgress?.Invoke("Push complete");
    }
}
