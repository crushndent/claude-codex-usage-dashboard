# GitHub Upload Guide

This guide shows how to upload this project to GitHub for the first time.

## 1. Create an Empty GitHub Repository

1. Sign in to GitHub.
2. Click the `+` button in the top-right corner.
3. Choose `New repository`.
4. Repository name: `claude-codex-usage-dashboard`.
5. Choose `Public` or `Private`.
6. Do not add a README, `.gitignore`, or license on GitHub, because this project already includes them.
7. Click `Create repository`.

GitHub will show a page with setup commands. Keep that page open.

## 2. Open PowerShell in the Project Folder

```powershell
cd "C:\path\to\claude-codex-usage-dashboard"
```

## 3. Initialize Git

```powershell
git init
```

## 4. Check the Files

```powershell
git status
```

You should see project files such as `README.md`, `server.js`, `LICENSE`, and `.gitignore`.

## 5. Create the First Commit

```powershell
git add .
git commit -m "Initial commit"
```

## 6. Connect to GitHub

Copy the remote URL from the empty GitHub repository page.

It will look like this:

```text
https://github.com/YOUR_NAME/claude-codex-usage-dashboard.git
```

Then run:

```powershell
git branch -M main
git remote add origin https://github.com/YOUR_NAME/claude-codex-usage-dashboard.git
```

Replace `YOUR_NAME` with your GitHub username.

## 7. Push the Project

```powershell
git push -u origin main
```

If GitHub asks you to sign in, follow the browser prompt or terminal instructions.

## 8. Confirm the Upload

Refresh your GitHub repository page. You should see the project files and the README rendered on the page.

## Updating the Project Later

After making changes:

```powershell
git status
git add .
git commit -m "Describe your change"
git push
```

## Common Issues

### Git asks who you are

Run these once:

```powershell
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

Use the same email you use for GitHub if you want commits linked to your profile.

### Remote origin already exists

Check it:

```powershell
git remote -v
```

If it is wrong:

```powershell
git remote set-url origin https://github.com/YOUR_NAME/claude-codex-usage-dashboard.git
```

### Push is rejected

If you created files directly on GitHub, the local and remote histories may differ. The easiest first-project fix is to create a new empty GitHub repository without adding README, `.gitignore`, or license, then push again.
