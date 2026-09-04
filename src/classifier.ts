import type { AdvisorConfig } from './config'
import type { ClassifierResult } from './types'

const HIGH_RISK_KEYWORDS = [
  '医疗', '药物', '剂量', '手术', '诊断', '法律', '合同', '诉讼', '合规', '税务',
  '投资', '理财', '保险', '安全漏洞', '漏洞利用', '核保', '判例', '法条',
  '责任', '赔偿', '监管', '刑事', '民事', '仲裁', '劳动法', '知识产权',
]

const WEB_SEARCH_KEYWORDS = [
  '最新', '新闻', '天气', '汇率', '股价', '价格', 'API文档', '版本', '更新',
  '公告', '活动', '时间', '日期', '在哪', '怎么下载', '官网', '仓库地址',
  '当前', '实时', '今日', '本周', '排行', '销量', '行情',
]

const WORLD_KNOWLEDGE_KEYWORDS = [
  '历史', '哲学', '理论', '学派', '文化', '术语', '概念', '原理', '行业惯例',
  '经验', '经典', '法理', '判例', '方法论', '框架', '最佳实践', '架构评审',
  '技术选型', '代码审查', '疑难', '根因', '学术', '论文', '研究', '文献',
  '政策', '制度', '机制', '商业模式', '战略', '组织', '管理',
  '数学', '证明', '推导', '统计', '回归', '概率', '算法', '复杂度', '优化',
  '物理', '化学', '生物', '工程', '材料', '量子',
]

const DOMAIN_KEYWORDS: Array<{ domain: string; keywords: string[] }> = [
  {
    domain: 'legal',
    keywords: ['法律', '合同', '诉讼', '合规', '税务', '法条', '判例', '责任', '仲裁', '劳动法', '知识产权'],
  },
  {
    domain: 'code',
    keywords: ['代码', '架构', '技术选型', 'bug', '调试', '性能', '安全漏洞', 'API', '系统设计', '数据库', '前端', '后端', '微服务'],
  },
  {
    domain: 'finance',
    keywords: ['投资', '理财', '金融', '税务', '保险', '估值', '财报', '现金流', '风险', '股票', '基金', '债券'],
  },
  {
    domain: 'medical',
    keywords: ['医疗', '药物', '剂量', '症状', '手术', '疾病', '诊断', '治疗', '康复'],
  },
  {
    domain: 'domain',
    keywords: ['行业惯例', '经验', '历史', '文化', '术语', '概念', '原理', '战略', '商业模式', '组织', '管理'],
  },
  {
    domain: 'technical',
    keywords: ['数学', '证明', '推导', '统计', '回归', '概率', '算法', '复杂度', '优化', '物理', '化学', '生物', '工程', '材料', '量子'],
  },
  {
    domain: 'academic',
    keywords: ['学术', '论文', '研究', '文献', '理论', '方法论'],
  },
]

export function classifyRequest(
  question: string,
  context: string | undefined,
  advisors: AdvisorConfig[] = [],
  confidence?: number,
  confidenceThreshold = 0.6,
): ClassifierResult {
  const text = `${question}\n${context ?? ''}`
  const lowerText = text.toLowerCase()

  if (text.includes('@顾问群') || text.includes('@顧問群')) {
    return {
      shouldEscalate: true,
      reason: '用户点名顾问群，强制启动顾问咨询。',
      suggestedAdvisors: matchAdvisors(lowerText, advisors),
      suggestWebSearch: false,
    }
  }

  if (HIGH_RISK_KEYWORDS.some((keyword) => lowerText.includes(keyword.toLowerCase()))) {
    return {
      shouldEscalate: true,
      reason: '命中高风险关键词，需要专业顾问参与并输出风险提示。',
      suggestedAdvisors: matchAdvisors(lowerText, advisors),
      suggestWebSearch: false,
    }
  }

  if (WORLD_KNOWLEDGE_KEYWORDS.some((keyword) => lowerText.includes(keyword.toLowerCase()))) {
    return {
      shouldEscalate: true,
      reason: '命中世界知识/专业经验关键词，适合由顾问模型提供多视角解答。',
      suggestedAdvisors: matchAdvisors(lowerText, advisors),
      suggestWebSearch: false,
    }
  }

  if (typeof confidence === 'number' && confidence < confidenceThreshold) {
    return {
      shouldEscalate: true,
      reason: `主模型置信度 ${confidence} 低于阈值 ${confidenceThreshold}，建议升级到顾问群。`,
      suggestedAdvisors: matchAdvisors(lowerText, advisors),
      suggestWebSearch: false,
    }
  }

  if (WEB_SEARCH_KEYWORDS.some((keyword) => lowerText.includes(keyword.toLowerCase()))) {
    return {
      shouldEscalate: false,
      reason: '该问题更依赖实时/事实信息，建议先联网搜索而不是启动顾问群。',
      suggestedAdvisors: [],
      suggestWebSearch: true,
    }
  }

  return {
    shouldEscalate: false,
    reason: '未识别出需要顾问参与的强信号，可由主模型自行处理。',
    suggestedAdvisors: [],
    suggestWebSearch: false,
  }
}

function matchAdvisors(text: string, advisors: AdvisorConfig[]): string[] {
  if (advisors.length === 0) return []
  const matches = new Set<string>()
  const lowerText = text.toLowerCase()

  for (const advisor of advisors) {
    const haystack = `${advisor.id} ${advisor.name} ${advisor.systemPrompt}`.toLowerCase()
    for (const { domain, keywords } of DOMAIN_KEYWORDS) {
      if (haystack.includes(domain)) {
        if (keywords.some((keyword) => lowerText.includes(keyword.toLowerCase()))) {
          matches.add(advisor.id)
        }
      }
    }
    // Also match when the advisor name appears directly in the question.
    if (lowerText.includes(advisor.name.toLowerCase()) || lowerText.includes(advisor.id.toLowerCase())) {
      matches.add(advisor.id)
    }
  }

  return [...matches]
}