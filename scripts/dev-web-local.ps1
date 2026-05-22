Set-Location 'D:\development\ads-management'
New-Item -ItemType Directory -Force -Path 'D:\development\ads-management\logs' | Out-Null
$env:META_FAKE = '1'
$env:API_PORT = '3001'
$env:WEB_PORT = '5173'
bun run dev:web *> 'D:\development\ads-management\logs\web.dev.task.log'
