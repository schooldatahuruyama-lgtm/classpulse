# Build/update the "pages" branch for GitHub Pages from HEAD's app files only
# (no history, no docs, no .ai-* folders).
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/pages-branch.ps1
# Then: git push origin pages   (first time: GitHub Settings > Pages > Branch: pages / (root))
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$paths = @("index.html", "check.html", "sw.js", "css", "js", "assets")
$tmpIndex = Join-Path $env:TEMP ("classpulse-pages-index-" + [guid]::NewGuid().ToString("N"))
$env:GIT_INDEX_FILE = $tmpIndex
try {
  git read-tree --empty
  $files = @(git ls-tree -r HEAD --name-only -- $paths)
  foreach ($f in $files) {
    $blob = (git rev-parse "HEAD:$f").Trim()
    git update-index --add --cacheinfo "100644,$blob,$f"
  }
  # .nojekyll: tell GitHub Pages not to run Jekyll
  $empty = ("" | git hash-object -w --stdin).Trim()
  git update-index --add --cacheinfo "100644,$empty,.nojekyll"
  $tree = (git write-tree).Trim()
} finally {
  Remove-Item Env:GIT_INDEX_FILE
  if (Test-Path $tmpIndex) { Remove-Item $tmpIndex }
}
$parent = git rev-parse --verify --quiet refs/heads/pages
$head = (git rev-parse --short HEAD).Trim()
$msg = "pages: $head"
if ($parent) { $commit = (git commit-tree $tree -p $parent.Trim() -m $msg).Trim() } else { $commit = (git commit-tree $tree -m $msg).Trim() }
git update-ref refs/heads/pages $commit
"pages branch updated: $commit (HEAD $head, files $($files.Count))"
