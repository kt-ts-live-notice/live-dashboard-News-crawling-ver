import { setTimeout as delay } from 'node:timers/promises'

export interface NewsAlert {
  id: number
  time: string
  title: string
  source: string
  link: string
  keyword: string
}

export interface NewsAlertSnapshot {
  alerts: NewsAlert[]
  latest_id: number
}

interface NewsItem {
  title: string
  source: string
  link: string
  pubDate: string
}

const QUERIES = [
  '전장연 시위',
  '지하철 시위',
  '지하철 사고',
  '지하철 고장',
  '지하철 지연',
  '지하철 운행 중단',
]

const POLL_INTERVAL_MS = 120_000
const MAX_AGE_HOURS = 24
const MAX_KEEP = 100
const RSS_URL = 'https://news.google.com/rss/search'

const SUBWAY_KEYWORDS = [
  '지하철',
  '전철',
  '호선',
  '열차',
  '전장연',
  '코레일',
  '서울교통공사',
  '역사',
  '승강장',
]

const INCIDENT_KEYWORDS = [
  '시위',
  '사고',
  '고장',
  '지연',
  '운행 중단',
  '운행중단',
  '중단',
  '파업',
  '탈선',
  '화재',
  '무정차',
  '멈춰',
  '멈춤',
  '정지',
  '운행 재개',
  '운행재개',
  '지장',
  '장애',
  '혼잡',
  '부상',
  '추돌',
]

const EXCLUDE_KEYWORDS = [
  '해외',
  '외신',
  '미국',
  '뉴욕',
  '일본',
  '도쿄',
  '오사카',
  '중국',
  '베이징',
  '상하이',
  '홍콩',
  '대만',
  '영국',
  '런던',
  '프랑스',
  '파리',
  '독일',
  '베를린',
  '스페인',
  '이탈리아',
  '러시아',
  '모스크바',
  '우크라이나',
  '인도',
  '이집트',
  '멕시코',
  '브라질',
  '튀르키예',
  '조지아',
  '싱가포르',
  '베트남',
  '태국',
  '필리핀',
  '인도네시아',
  '캐나다',
  '호주',
]

function clean(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

function readTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return clean(match?.[1] ?? '')
}

function isIncidentNews(title: string): boolean {
  return SUBWAY_KEYWORDS.some((keyword) => title.includes(keyword)) &&
    INCIDENT_KEYWORDS.some((keyword) => title.includes(keyword))
}

function isKoreaRelated(title: string): boolean {
  return !EXCLUDE_KEYWORDS.some((keyword) => title.includes(keyword))
}

function isRecent(pubDate: string): boolean {
  const publishedAt = Date.parse(pubDate)
  if (!Number.isFinite(publishedAt)) return false
  const ageHours = (Date.now() - publishedAt) / 3_600_000
  return ageHours >= 0 && ageHours <= MAX_AGE_HOURS
}

async function fetchNews(query: string): Promise<NewsItem[]> {
  const url = new URL(RSS_URL)
  url.searchParams.set('q', `${query} when:1d`)
  url.searchParams.set('hl', 'ko')
  url.searchParams.set('gl', 'KR')
  url.searchParams.set('ceid', 'KR:ko')

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
    },
  })
  if (!response.ok) throw new Error(`Google News RSS returned ${response.status}`)

  const xml = await response.text()
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].slice(0, 10).map((match) => {
    let title = readTag(match[0], 'title')
    let source = ''
    const titleParts = title.split(' - ')
    if (titleParts.length > 1) {
      source = titleParts.pop() ?? ''
      title = titleParts.join(' - ')
    }

    return {
      title,
      source,
      link: readTag(match[0], 'link'),
      pubDate: readTag(match[0], 'pubDate'),
    }
  })
}

export class NewsAlertStore {
  private alerts: NewsAlert[] = []
  private latestId = 0
  private running = false
  private firstRun = true
  private readonly seenLinks = new Set<string>()
  private abortController: AbortController | null = null

  snapshot(): NewsAlertSnapshot {
    return {
      alerts: [...this.alerts].reverse(),
      latest_id: this.latestId,
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.abortController = new AbortController()
    void this.loop(this.abortController.signal)
  }

  stop(): void {
    this.running = false
    this.abortController?.abort()
    this.abortController = null
  }

  private addAlert(item: NewsItem, keyword: string): void {
    this.latestId += 1
    this.alerts.push({
      id: this.latestId,
      time: new Date().toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }),
      title: item.title,
      source: item.source,
      link: item.link,
      keyword,
    })
    this.alerts = this.alerts.slice(-MAX_KEEP)
  }

  private async loop(signal: AbortSignal): Promise<void> {
    console.log(`뉴스 크롤링 시작 (${POLL_INTERVAL_MS / 1000}초 간격, 최근 ${MAX_AGE_HOURS}시간 이내 지하철 사건 기사만)`)

    while (!signal.aborted) {
      for (const query of QUERIES) {
        if (signal.aborted) return

        try {
          const items = await fetchNews(query)
          for (const item of items) {
            if (!item.link || this.seenLinks.has(item.link)) continue
            this.seenLinks.add(item.link)
            if (!isRecent(item.pubDate)) continue
            if (!isIncidentNews(item.title)) continue
            if (!isKoreaRelated(item.title)) continue
            if (this.firstRun && item !== items[0]) continue
            this.addAlert(item, query)
            console.log(`[news-alert:${query}] ${item.title}`)
          }
        } catch (error) {
          console.warn(`[news-alert] 조회 실패 [${query}]: ${error instanceof Error ? error.message : String(error)}`)
        }

        await delay(2_000, undefined, { signal }).catch(() => undefined)
      }

      this.firstRun = false
      await delay(POLL_INTERVAL_MS, undefined, { signal }).catch(() => undefined)
    }
  }
}
