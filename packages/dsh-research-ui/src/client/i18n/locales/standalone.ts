/**
 * standalone namespace (gui-plugin-plan §13.1): the unlock screen chrome.
 * Selected before the first render (§13.4); dynamic research content is
 * never translated.
 */
export const zh = {
  'standalone.brand.mark': 'dsh',
  'standalone.brand.name': 'Scholar',
  'standalone.brand.meta': '工作区',
  'standalone.pageTitle': 'dsh Scholar',
  'standalone.operatorAccess': '操作员访问',
  'standalone.welcomeBack': '欢迎回来。',
  'standalone.intro': '打开你的证据工作区。人类 Gate 决策将以你的操作员身份记录。',
  'standalone.accessToken': '访问令牌',
  'standalone.openWorkspace': '打开工作区',
  'standalone.invalidToken': '无效令牌',
  'standalone.tokenRequired': '请输入访问令牌。',
  'standalone.serverUnreachable': '服务器不可达',
  'standalone.bundleFailed': '客户端加载失败',
  'standalone.tokenHint': '请从本机服务器数据目录中的 standalone-token 文件获取令牌。',
  'standalone.theme.dark': '深色',
  'standalone.theme.light': '浅色',
} as const

export type StandaloneKey = keyof typeof zh

export const en: Record<StandaloneKey, string> = {
  'standalone.brand.mark': 'dsh',
  'standalone.brand.name': 'Scholar',
  'standalone.brand.meta': 'Workspace',
  'standalone.pageTitle': 'dsh Scholar',
  'standalone.operatorAccess': 'Operator access',
  'standalone.welcomeBack': 'Welcome back.',
  'standalone.intro': 'Open your evidence workspace. Human gate decisions are recorded with your operator identity.',
  'standalone.accessToken': 'Access token',
  'standalone.openWorkspace': 'Open workspace',
  'standalone.invalidToken': 'Invalid token',
  'standalone.tokenRequired': 'Enter an access token.',
  'standalone.serverUnreachable': 'Server unreachable',
  'standalone.bundleFailed': 'Client bundle failed to load',
  'standalone.tokenHint': 'Find your token in the standalone-token file in the local server data directory.',
  'standalone.theme.dark': 'Dark',
  'standalone.theme.light': 'Light',
}
