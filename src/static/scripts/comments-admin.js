const apiRoot = document.body.dataset.apiRoot?.replace(/\/$/, '') || ''
const authPanel = document.getElementById('auth-panel')
const authForm = document.getElementById('auth-form')
const tokenInput = document.getElementById('admin-token')
const rememberToken = document.getElementById('remember-token')
const authStatus = document.getElementById('auth-status')
const disconnectButton = document.getElementById('disconnect-btn')
const moderationPanel = document.getElementById('moderation-panel')
const refreshButton = document.getElementById('refresh-btn')
const moderationStatus = document.getElementById('moderation-status')
const commentQueue = document.getElementById('comment-queue')
const loadMoreButton = document.getElementById('load-more-btn')

const tokenStorageKey = `memebox.commentAdminToken:${apiRoot}`
let adminToken = ''
let entryPaths = new Map()
let nextBefore = null
let loading = false

function readToken() {
    try {
        return sessionStorage.getItem(tokenStorageKey) || ''
    } catch (_) {
        return ''
    }
}

function persistToken(value) {
    try {
        if (rememberToken.checked) sessionStorage.setItem(tokenStorageKey, value)
        else sessionStorage.removeItem(tokenStorageKey)
    } catch (_) {
        // The page still works when session storage is unavailable.
    }
}

function clearToken() {
    try {
        sessionStorage.removeItem(tokenStorageKey)
    } catch (_) {
        // Session storage is optional.
    }
}

async function apiRequest(path, options = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    try {
        const response = await fetch(`${apiRoot}/api/v1${path}`, {
            method: options.method || 'GET',
            headers: {
                Authorization: `Bearer ${adminToken}`,
                ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            referrerPolicy: 'no-referrer',
            signal: controller.signal,
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`)
        return data
    } finally {
        clearTimeout(timer)
    }
}

async function loadEntryPaths() {
    try {
        const config = (await import(`/static/scripts/config.js?v=${Date.now()}`)).default
        entryPaths = new Map(
            (Array.isArray(config.entries) ? config.entries : [])
                .filter((entry) => entry?.uid && entry?.id)
                .map((entry) => [String(entry.uid), String(entry.id)])
        )
    } catch (_) {
        entryPaths = new Map()
    }
}

function entryUrl(entryId) {
    const pathId = entryPaths.get(entryId)
    return pathId ? `/#${encodeURIComponent(pathId)}` : '/'
}

function renderComment(comment) {
    const node = document.getElementById('moderation-item').content.firstElementChild.cloneNode(true)
    node.dataset.commentId = comment.id
    node.querySelector('.comment-author').textContent = String(comment.author || '')
    node.querySelector('.comment-body').textContent = String(comment.body || '')
    node.querySelector('.comment-state').textContent = comment.status === 'rejected'
        ? '历史隐藏评论'
        : ''
    const time = node.querySelector('time')
    const createdAt = new Date(comment.created_at)
    time.dateTime = comment.created_at
    time.textContent = Number.isFinite(createdAt.getTime()) ? createdAt.toLocaleString() : ''
    node.querySelector('.entry-link').href = entryUrl(String(comment.entry_id || ''))

    const deleteButton = node.querySelector('.delete-btn')
    deleteButton.addEventListener('click', () => deleteComment(comment.id, node))
    return node
}

async function loadComments({ append = false } = {}) {
    if (loading) return
    loading = true
    refreshButton.disabled = true
    loadMoreButton.disabled = true
    moderationStatus.textContent = '正在加载...'
    try {
        const query = new URLSearchParams({ limit: '50' })
        if (append && nextBefore) query.set('before', String(nextBefore))
        const data = await apiRequest(`/admin/comments?${query}`)
        const comments = Array.isArray(data.comments) ? data.comments : []
        if (!append) commentQueue.replaceChildren()
        comments.forEach((comment) => commentQueue.append(renderComment(comment)))
        nextBefore = comments.length === 50 ? comments.at(-1).id : null
        loadMoreButton.hidden = !nextBefore
        moderationStatus.textContent = commentQueue.children.length === 0 ? '没有评论' : ''
    } catch (error) {
        moderationStatus.textContent = error.name === 'AbortError' ? '请求超时' : error.message
    } finally {
        loading = false
        refreshButton.disabled = false
        loadMoreButton.disabled = false
    }
}

async function deleteComment(commentId, node) {
    if (!window.confirm('确定彻底删除这条评论吗？')) return
    const buttons = node.querySelectorAll('button')
    buttons.forEach((button) => { button.disabled = true })
    moderationStatus.textContent = '正在删除...'
    try {
        await apiRequest(`/admin/comments/${commentId}`, { method: 'DELETE' })
        node.remove()
        moderationStatus.textContent = commentQueue.children.length === 0 ? '没有评论' : '已删除'
    } catch (error) {
        moderationStatus.textContent = error.name === 'AbortError' ? '请求超时' : error.message
    } finally {
        buttons.forEach((button) => { button.disabled = false })
    }
}

async function connect(value) {
    adminToken = value.trim()
    if (!adminToken) return
    authStatus.textContent = '正在连接...'
    await apiRequest('/admin/comments?limit=1')
    persistToken(adminToken)
    tokenInput.value = ''
    authPanel.hidden = true
    disconnectButton.hidden = false
    moderationPanel.hidden = false
    authStatus.textContent = ''
    await loadComments()
}

function disconnect() {
    adminToken = ''
    clearToken()
    commentQueue.replaceChildren()
    moderationPanel.hidden = true
    disconnectButton.hidden = true
    authPanel.hidden = false
    authStatus.textContent = ''
}

authForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const button = authForm.querySelector('button[type="submit"]')
    button.disabled = true
    try {
        await connect(tokenInput.value)
    } catch (error) {
        adminToken = ''
        clearToken()
        authStatus.textContent = error.name === 'AbortError' ? '连接超时' : error.message
    } finally {
        button.disabled = false
    }
})

disconnectButton.addEventListener('click', disconnect)
refreshButton.addEventListener('click', () => loadComments())
loadMoreButton.addEventListener('click', () => loadComments({ append: true }))

await loadEntryPaths()
const savedToken = readToken()
if (savedToken) {
    try {
        await connect(savedToken)
    } catch (error) {
        adminToken = ''
        clearToken()
        authStatus.textContent = error.name === 'AbortError' ? '连接超时' : error.message
    }
}
