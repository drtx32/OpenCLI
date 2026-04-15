import { cli, Strategy } from '@jackwener/opencli/registry';
import { ensureZsxqAuth, ensureZsxqPage, fetchFirstJson, getActiveGroupId, unwrapRespData, getTopicAuthor, getTopicUrl, summarizeComments } from './utils.js';

const API_BASE = 'https://api.zsxq.com';

// Concurrency queue — limits simultaneous API requests to prevent rate limiting
class AsyncQueue {
    constructor(maxConcurrency = 3) {
        this.maxConcurrency = maxConcurrency;
        this.running = 0;
        this.queue = [];
    }

    async enqueue(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            this._process();
        });
    }

    _process() {
        while (this.running < this.maxConcurrency && this.queue.length > 0) {
            const { task, resolve, reject } = this.queue.shift();
            this.running++;
            task()
                .then(resolve)
                .catch(reject)
                .finally(() => {
                    this.running--;
                    this._process();
                });
        }
    }
}

function buildTopicRow(topic) {
    const topicId = String(topic.topic_id ?? '');
    const talk = topic.talk ?? {};
    const comments = topic.show_comments ?? topic.comments ?? [];
    const author = getTopicAuthor(topic);

    const rawTitle = topic.title ?? '';
    const talkText = talk.text ?? '';

    const isGenericTitle = /^「[^」]+」$/.test(String(rawTitle).trim()) && !talkText;
    const title = isGenericTitle ? rawTitle.slice(0, 120) : talkText.slice(0, 120);
    const content = talkText;

    return {
        topic_id: topicId,
        type: topic.type || '',
        group: topic.group?.name || '',
        author,
        title,
        content,
        comments: topic.comments_count ?? comments.length ?? 0,
        likes: topic.likes_count ?? 0,
        readers: topic.readers_count ?? topic.reading_count ?? 0,
        time: topic.create_time || '',
        comment_preview: summarizeComments(comments),
        url: getTopicUrl(topicId),
    };
}

cli({
    site: 'zsxq',
    name: 'topics',
    description: '获取当前星球的话题列表（支持文件/图片附件，分页）',
    domain: 'wx.zsxq.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'limit', type: 'int', default: 30, help: '数量（分页自动累加）' },
        { name: 'end_time', help: '起始时间戳（ISO 格式或时间戳，传入后可获取更早的内容，配合 limit 翻页）' },
        { name: 'group_id', help: '星球 ID（留空则自动获取当前星球）' },
        { name: 'resolve_files', default: true, help: '是否解析文件下载链接（设为 false 可大幅提升大批量拉取速度）' },
    ],
    columns: ['topic_id', 'type', 'author', 'title', 'content', 'comments', 'likes', 'time', 'images', 'files'],
    func: async (page, kwargs) => {
        await ensureZsxqPage(page);
        await ensureZsxqAuth(page);
        const limit = Math.max(1, Number(kwargs.limit) || 30);
        const groupId = String(kwargs.group_id || await getActiveGroupId(page));

        // Fetch pages sequentially using end_time cursor pagination
        const PAGE_SIZE = 30;
        const pageResults = [];
        let lastTopicTime = kwargs.end_time ? String(kwargs.end_time) : '';

        while (pageResults.flat().length < limit) {
            let topics = [];
            const url = lastTopicTime
                ? `${API_BASE}/v2/groups/${groupId}/topics?scope=all&count=${PAGE_SIZE}&end_time=${encodeURIComponent(lastTopicTime)}`
                : `${API_BASE}/v2/groups/${groupId}/topics?scope=all&count=${PAGE_SIZE}`;

            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const { data } = await fetchFirstJson(page, [url]);
                    topics = Array.isArray(data) ? data : (unwrapRespData(data)?.topics ?? []);
                    break;
                } catch (err) {
                    if (attempt === 2) throw err;
                    await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); // backoff 2s, 4s
                }
            }

            if (!topics || topics.length === 0) break;
            pageResults.push(topics);

            // Use last topic's create_time as next cursor
            lastTopicTime = topics[topics.length - 1].create_time || '';

            if (pageResults.flat().length >= limit || topics.length < PAGE_SIZE) break;
            if (pageResults.length > 0) await new Promise(r => setTimeout(r, 500)); // stagger between pages
        }

        const rawTopics = pageResults.flat().slice(0, limit);

        const resolveFiles = kwargs.resolve_files !== false;
        const topicFileUrls = new Map(); // topicId -> Map(idx -> url)

        if (resolveFiles) {
            // Collect topics that have files (topicId always as string for consistent Map keys)
            const topicsWithFiles = rawTopics
                .filter(t => (t.talk?.files ?? []).length > 0)
                .map(t => ({ topicId: String(t.topic_id ?? ''), files: t.talk.files }));

            // Process topics in parallel (max 3 concurrent),
            // but within each topic, fetch files sequentially with stagger
            const topicQueue = new AsyncQueue(3);
            await Promise.all(
                topicsWithFiles.map(({ topicId, files }) =>
                    topicQueue.enqueue(async () => {
                        const fileUrlMap = new Map();
                        for (let idx = 0; idx < files.length; idx++) {
                            const f = files[idx];
                            if (!f.file_id) continue;
                            await new Promise(r => setTimeout(r, 800)); // stagger within topic
                            try {
                                const { data } = await fetchFirstJson(page, [`${API_BASE}/v2/files/${f.file_id}/download_url?group_id=${groupId}`]);
                                const url = unwrapRespData(data)?.download_url ?? '';
                                fileUrlMap.set(idx, url);
                            } catch {
                                // leave empty on failure
                            }
                        }
                        topicFileUrls.set(topicId, fileUrlMap);
                    })
                )
            );
        }

        // Assemble rows
        const rows = [];
        for (const topic of rawTopics) {
            const topicId = topic.topic_id ?? '';
            const row = buildTopicRow(topic);

            // images: already in topic data, no extra request
            const images = [];
            for (const img of topic.talk?.images ?? []) {
                if (img.large?.url) images.push(img.large.url);
            }
            row.images = images;

            // files: look up download URLs by topicId+index
            const fileUrlMap = topicFileUrls.get(String(topicId)) ?? new Map();
            row.files = (topic.talk?.files ?? []).map((f, idx) => ({
                name: f.name ?? '',
                url: fileUrlMap.get(idx) ?? '',
            }));

            rows.push(row);
        }
        return rows;
    },
});
