Set-Location 'D:\development\ads-management'
New-Item -ItemType Directory -Force -Path 'D:\development\ads-management\logs' | Out-Null
$env:META_FAKE = '1'
$env:API_PORT = '3001'
bun run dev:api *> 'D:\development\ads-management\logs\api.dev.task.log'
