const config = (await import(`./config.js?v=${Date.now()}`)).default

const imageRegex = /^meme\/(.+)\.(?:jpg|png|jfif|webp|gif|jpeg|bmp)$/i
const columns = ['col1', 'col2', 'col3'].map((id) => document.getElementById(id))
const categoryTabs = document.getElementById('category-tabs')
const galleryShell = document.getElementById('gallery-shell')
const galleryControls = document.getElementById('gallery-controls')
const emptyState = document.getElementById('empty-state')
const sensitiveControl = document.getElementById('sensitive-control')
const sensitiveToggle = document.getElementById('show-sensitive')
const sortSelect = document.getElementById('sort-order')
const footer = document.getElementById('footer')
const viewElement = document.getElementById('view')
const viewImages = document.getElementById('view-images')
const viewSensitiveGate = document.getElementById('view-sensitive-gate')
const viewDownload = document.getElementById('view-download')

let categories = []
let entries = []
let imageCount = 0
let activeCategory = 'all'
let visibleEntries = []
let displayedItemCount = 0
let galleryLoading = false
let galleryVersion = 0
let galleryReturnState = null
let galleryRestoreVersion = 0
let renderedGalleryColumnCount = galleryColumnCountForViewport()
let galleryNeedsLayout = false
let showSensitive = readSensitivePreference()
let sortOrder = readSortPreference()

const galleryIO = new IntersectionObserver((observedEntries) => {
    if (!galleryShell.hidden && observedEntries.some((entry) => entry.isIntersecting)) {
        loadGallery(12)
    }
}, { rootMargin: '800px 0px' })

function readSensitivePreference() {
    try {
        return localStorage.getItem('memebox.showSensitive') === 'true'
    } catch (_) {
        return false
    }
}

function saveSensitivePreference(value) {
    try {
        localStorage.setItem('memebox.showSensitive', String(value))
    } catch (_) {
        // The preference is optional when storage is unavailable.
    }
}

function readSortPreference() {
    try {
        const value = localStorage.getItem('memebox.sortOrder')
        return ['random', 'newest', 'oldest'].includes(value) ? value : 'random'
    } catch (_) {
        return 'random'
    }
}

function saveSortPreference(value) {
    try {
        localStorage.setItem('memebox.sortOrder', value)
    } catch (_) {
        // The preference is optional when storage is unavailable.
    }
}

function naturalCompare(left, right) {
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
}

function assetUrl(path) {
    return './' + path.split('/').map((part) => encodeURIComponent(part)).join('/')
}

function randomItem(items) {
    return items[Math.floor(Math.random() * items.length)]
}

function shuffled(items) {
    const result = [...items]
    for (let i = result.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[result[i], result[j]] = [result[j], result[i]]
    }
    return result
}

function normalizedUploadTime(value) {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return ''
    return value
}

function latestImageUpload(images, uploads) {
    return images
        .map((path) => normalizedUploadTime(uploads[path]))
        .filter(Boolean)
        .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || ''
}

function orderedEntries(items) {
    if (sortOrder === 'random') return shuffled(items)
    const direction = sortOrder === 'newest' ? -1 : 1
    return [...items].sort((left, right) => {
        const leftTime = Date.parse(left.uploadedAt)
        const rightTime = Date.parse(right.uploadedAt)
        const leftKnown = Number.isFinite(leftTime)
        const rightKnown = Number.isFinite(rightTime)
        if (leftKnown !== rightKnown) return leftKnown ? -1 : 1
        if (leftKnown && leftTime !== rightTime) return (leftTime - rightTime) * direction
        return naturalCompare(left.id, right.id)
    })
}

function normalizeConfig(rawConfig) {
    const uploads = rawConfig.uploads && typeof rawConfig.uploads === 'object'
        ? rawConfig.uploads
        : {}
    const normalizedCategories = Array.isArray(rawConfig.categories)
        ? rawConfig.categories.map((category, index) => ({
            id: String(category.id),
            label: String(category.label || category.id),
            order: Number.isFinite(Number(category.order)) ? Number(category.order) : index * 10,
            sensitive: Boolean(category.sensitive),
        }))
        : [{ id: 'default', label: '未分类', order: 0, sensitive: false }]

    if (!normalizedCategories.some((category) => category.id === 'default')) {
        normalizedCategories.unshift({
            id: 'default',
            label: '未分类',
            order: 0,
            sensitive: false,
        })
    }

    const categoryMap = new Map(normalizedCategories.map((category) => [category.id, category]))
    let normalizedEntries = []

    if (Array.isArray(rawConfig.entries)) {
        normalizedEntries = rawConfig.entries
            .filter((entry) => entry && Array.isArray(entry.images) && entry.images.length > 0)
            .map((entry) => {
                const categoryId = String(entry.category || 'default')
                if (!categoryMap.has(categoryId)) {
                    const fallbackCategory = {
                        id: categoryId,
                        label: categoryId,
                        order: normalizedCategories.length * 10,
                        sensitive: false,
                    }
                    normalizedCategories.push(fallbackCategory)
                    categoryMap.set(categoryId, fallbackCategory)
                }
                const images = entry.images.map(String).filter((path) => imageRegex.test(path))
                return {
                    id: String(entry.id),
                    title: String(entry.title || entry.id),
                    category: categoryId,
                    sensitive: Boolean(entry.sensitive || categoryMap.get(categoryId).sensitive),
                    images,
                    uploadedAt: normalizedUploadTime(entry.uploadedAt)
                        || latestImageUpload(images, uploads),
                }
            })
            .filter((entry) => entry.images.length > 0)
    } else if (Array.isArray(rawConfig.items)) {
        normalizedEntries = rawConfig.items
            .filter((path) => typeof path === 'string' && imageRegex.test(path))
            .map((path) => {
                const filename = path.split('/').pop()
                const id = filename.replace(/\.[^.]+$/, '')
                return {
                    id,
                    title: id,
                    category: 'default',
                    sensitive: false,
                    images: [path],
                    uploadedAt: normalizedUploadTime(uploads[path]),
                }
            })
    }

    normalizedCategories.sort((left, right) =>
        left.order - right.order || naturalCompare(left.label, right.label)
    )
    return { categories: normalizedCategories, entries: normalizedEntries }
}

function categoryLabel(categoryId) {
    return categories.find((category) => category.id === categoryId)?.label || categoryId
}

function galleryColumnCountForViewport() {
    if (window.matchMedia('(max-width: 620px)').matches) return 1
    if (window.matchMedia('(max-width: 900px)').matches) return 2
    return 3
}

function getVisibleColumns() {
    const visibleColumns = columns.filter(
        (column) => getComputedStyle(column).display !== 'none'
    )
    return visibleColumns.length > 0 ? visibleColumns : [columns[0]]
}

function createMemeElement(entry) {
    const node = document.getElementById('gallery-item').content.firstElementChild.cloneNode(true)
    const link = node.querySelector('a')
    const image = node.querySelector('img')
    const count = node.querySelector('.item-count')
    const longBadge = node.querySelector('.item-long')

    link.href = `#${encodeURIComponent(entry.id)}`
    node.dataset.entryId = entry.id
    link.addEventListener('click', (event) => {
        if (
            event.button !== 0
            || event.metaKey
            || event.ctrlKey
            || event.shiftKey
            || event.altKey
        ) return
        galleryRestoreVersion += 1
        galleryReturnState = {
            entryId: entry.id,
            scrollY: window.scrollY,
            viewportTop: node.getBoundingClientRect().top,
        }
    })
    image.addEventListener('load', () => {
        const isLongImage = image.naturalWidth > 0
            && image.naturalHeight / image.naturalWidth > 4
        node.classList.toggle('is-long', isLongImage)
        longBadge.hidden = !isLongImage
    }, { once: true })
    image.src = assetUrl(entry.images[0])
    image.alt = entry.title
    node.querySelector('.item-title').textContent = entry.title
    if (entry.images.length > 1) {
        count.hidden = false
        count.textContent = `${entry.images.length} 张`
    }
    return node
}

function waitForImage(image) {
    if (image.complete) return Promise.resolve()
    return new Promise((resolve) => {
        image.addEventListener('load', resolve, { once: true })
        image.addEventListener('error', resolve, { once: true })
    })
}

async function loadGallery(remainItemCount) {
    const version = galleryVersion
    if (galleryLoading || remainItemCount <= 0 || displayedItemCount >= visibleEntries.length) {
        return
    }

    galleryLoading = true
    galleryIO.unobserve(footer)
    try {
        while (
            version === galleryVersion &&
            remainItemCount > 0 &&
            displayedItemCount < visibleEntries.length
        ) {
            const entry = visibleEntries[displayedItemCount]
            displayedItemCount += 1
            remainItemCount -= 1

            const column = getVisibleColumns().sort(
                (left, right) => left.offsetHeight - right.offsetHeight
            )[0]
            const node = createMemeElement(entry)
            column.append(node)
            await waitForImage(node.querySelector('img'))
        }
    } finally {
        if (version === galleryVersion) {
            galleryLoading = false
            if (displayedItemCount < visibleEntries.length) galleryIO.observe(footer)
        }
    }
}

function filteredEntries() {
    return entries.filter((entry) => {
        const categoryMatches = activeCategory === 'all' || entry.category === activeCategory
        return categoryMatches && (showSensitive || !entry.sensitive)
    })
}

function hiddenBySensitiveFilter() {
    return entries.some((entry) => {
        const categoryMatches = activeCategory === 'all' || entry.category === activeCategory
        return categoryMatches && entry.sensitive
    })
}

function renderGallery() {
    renderedGalleryColumnCount = galleryColumnCountForViewport()
    galleryNeedsLayout = false
    galleryVersion += 1
    galleryLoading = false
    galleryIO.unobserve(footer)
    columns.forEach((column) => column.replaceChildren())
    displayedItemCount = 0
    visibleEntries = orderedEntries(filteredEntries())
    emptyState.hidden = visibleEntries.length > 0
    emptyState.textContent =
        !showSensitive && hiddenBySensitiveFilter()
            ? '敏感内容已隐藏'
            : '暂无内容'
    loadGallery(12)
}

function renderCategoryTabs() {
    categoryTabs.replaceChildren()
    const tabs = [{ id: 'all', label: '全部' }, ...categories]
    for (const category of tabs) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'category-tab'
        button.dataset.category = category.id
        button.setAttribute('aria-pressed', String(activeCategory === category.id))
        button.textContent = category.label
        button.addEventListener('click', () => {
            activeCategory = category.id
            categoryTabs.querySelectorAll('button').forEach((tab) =>
                tab.setAttribute('aria-pressed', String(tab === button))
            )
            if (location.hash) history.replaceState(null, '', location.pathname + location.search)
            showGallery()
            renderGallery()
        })
        categoryTabs.append(button)
    }
}

function currentEntry() {
    if (!location.hash || location.hash === '#') return null
    try {
        const id = decodeURIComponent(location.hash.slice(1))
        return entries.find((entry) => entry.id === id) || null
    } catch (_) {
        return null
    }
}

function showGallery() {
    viewElement.hidden = true
    galleryControls.hidden = false
    galleryShell.hidden = false
}

function renderedGalleryEntry(entryId) {
    return [...document.querySelectorAll('.item')].find(
        (item) => item.dataset.entryId === entryId
    ) || null
}

async function restoreGalleryPosition() {
    const state = galleryReturnState
    if (!state) return
    const restoreVersion = ++galleryRestoreVersion

    let target = renderedGalleryEntry(state.entryId)
    while (!target && galleryLoading && restoreVersion === galleryRestoreVersion) {
        await new Promise((resolve) => setTimeout(resolve, 16))
        target = renderedGalleryEntry(state.entryId)
    }

    while (
        !target
        && displayedItemCount < visibleEntries.length
        && restoreVersion === galleryRestoreVersion
    ) {
        await loadGallery(12)
        target = renderedGalleryEntry(state.entryId)
    }

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    if (restoreVersion !== galleryRestoreVersion) return

    if (target) {
        const targetY = window.scrollY + target.getBoundingClientRect().top - state.viewportTop
        window.scrollTo({ top: targetY, behavior: 'auto' })
    } else {
        window.scrollTo({ top: state.scrollY, behavior: 'auto' })
    }
    galleryReturnState = null
}

function renderViewImage(entry, imagePath, index) {
    const node = document.getElementById('view-image').content.firstElementChild.cloneNode(true)
    const imageUrl = assetUrl(imagePath)
    const image = node.querySelector('img')
    const zoomLink = node.querySelector('a[target]')
    const downloadLink = node.querySelector('a[download]')

    image.src = imageUrl
    image.alt = `${entry.title} ${index + 1}`
    if (index === 0) image.loading = 'eager'
    zoomLink.href = imageUrl
    downloadLink.href = imageUrl
    node.querySelector('figcaption span').textContent = `${index + 1} / ${entry.images.length}`
    return node
}

function renderView() {
    const entry = currentEntry()
    if (!entry) {
        showGallery()
        if (galleryNeedsLayout) renderGallery()
        restoreGalleryPosition()
        return
    }

    viewElement.hidden = false
    galleryControls.hidden = true
    galleryShell.hidden = true
    viewImages.replaceChildren()
    document.getElementById('view-title').textContent = entry.title
    document.getElementById('view-category').textContent = categoryLabel(entry.category)

    const blocked = entry.sensitive && !showSensitive
    viewSensitiveGate.hidden = !blocked
    viewImages.hidden = blocked
    viewDownload.hidden = blocked || entry.images.length !== 1

    if (!blocked) {
        entry.images.forEach((imagePath, index) =>
            viewImages.append(renderViewImage(entry, imagePath, index))
        )
        if (entry.images.length === 1) viewDownload.href = assetUrl(entry.images[0])
    }

    window.scrollTo({ top: viewElement.offsetTop, behavior: 'smooth' })
}

function setSensitiveVisibility(value) {
    showSensitive = value
    sensitiveToggle.checked = value
    saveSensitivePreference(value)
    renderGallery()
    renderView()
}

function init() {
    const normalized = normalizeConfig(config)
    categories = normalized.categories
    entries = normalized.entries
    imageCount = entries.reduce((total, entry) => total + entry.images.length, 0)

    document.getElementById('description').textContent = `Joy for Everyone, 目前已有 ${entries.length} 组，共 ${imageCount} 张。`
    sensitiveControl.hidden = !entries.some((entry) => entry.sensitive)
    sensitiveToggle.checked = showSensitive
    sortSelect.value = sortOrder
    sensitiveToggle.addEventListener('change', () =>
        setSensitiveVisibility(sensitiveToggle.checked)
    )
    sortSelect.addEventListener('change', () => {
        sortOrder = sortSelect.value
        saveSortPreference(sortOrder)
        renderGallery()
    })
    document.getElementById('reveal-sensitive').addEventListener('click', () =>
        setSensitiveVisibility(true)
    )
    document.getElementById('refresh-btn').addEventListener('click', () => {
        const candidates = filteredEntries()
        if (candidates.length > 0) location.hash = `#${encodeURIComponent(randomItem(candidates).id)}`
    })
    document.getElementById('view-back-btn').addEventListener('click', () => {
        history.replaceState(null, '', location.pathname + location.search)
        renderView()
    })

    renderCategoryTabs()
    renderGallery()
    renderView()
    window.addEventListener('hashchange', renderView)
    let resizeTimer
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => {
            const columnCount = galleryColumnCountForViewport()
            if (columnCount === renderedGalleryColumnCount) {
                galleryNeedsLayout = false
                return
            }
            if (viewElement.hidden) renderGallery()
            else galleryNeedsLayout = true
        }, 150)
    })
}

init()
