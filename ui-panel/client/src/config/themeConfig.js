// 主题配置文件 - 通过修改 ACTIVE_THEME 来切换风格
// 可选主题: 'aws', 'neutral', 'modern', 'classic'

export const ACTIVE_THEME = 'aws'; // 在这里切换主题

// 配色模式开关:
//   'auto'  = 跟随 macOS/浏览器的 prefers-color-scheme
//   'light' = 强制亮色，忽略系统设置
//   'dark'  = 强制暗色，忽略系统设置
export const COLOR_SCHEME_MODE = 'light';

// AWS 风格主题
const awsTheme = {
  name: 'aws',
  colors: {
    primary: '#FF9900',
    primaryLight: '#FFB84D',
    primaryDark: '#E6890A',
    secondary: '#232F3E',
    secondaryLight: '#37475A',
    secondaryDark: '#161E2D',
    
    success: '#1D8102',
    warning: '#FF9900',
    error: '#D13212',
    info: '#0073BB',
    
    // 服务特定颜色
    compute: '#FF9900',
    storage: '#3F48CC',
    database: '#C925D1',
    ml: '#01A88D',
    analytics: '#8C4FFF',
    
    // 灰度色阶
    gray50: '#FAFBFC',
    gray100: '#F2F3F3',
    gray200: '#EAEDED',
    gray300: '#D5DBDB',
    gray400: '#A9B7BC',
    gray500: '#879196',
    gray600: '#687078',
    gray700: '#4F5B62',
    gray800: '#37424A',
    gray900: '#232F3E'
  },
  
  typography: {
    fontFamily: "'Amazon Ember', 'Helvetica Neue', Arial, sans-serif",
    headerSize: '24px',
    headerWeight: '600'
  },
  
  layout: {
    headerGradient: 'linear-gradient(135deg, #232F3E 0%, #37475A 100%)',
    headerBorder: '3px solid #FF9900',
    cardRadius: '12px',
    buttonRadius: '8px'
  },
  
  branding: {
    showServiceIcons: true,
    showGradients: true,
    emphasizeStatus: true
  }
};

// 中性风格主题
const neutralTheme = {
  name: 'neutral',
  colors: {
    primary: '#1890ff',
    primaryLight: '#40a9ff',
    primaryDark: '#096dd9',
    secondary: '#595959',
    secondaryLight: '#8c8c8c',
    secondaryDark: '#262626',
    
    success: '#52c41a',
    warning: '#faad14',
    error: '#f5222d',
    info: '#1890ff',
    
    compute: '#1890ff',
    storage: '#722ed1',
    database: '#eb2f96',
    ml: '#13c2c2',
    analytics: '#52c41a',
    
    gray50: '#fafafa',
    gray100: '#f5f5f5',
    gray200: '#f0f0f0',
    gray300: '#d9d9d9',
    gray400: '#bfbfbf',
    gray500: '#8c8c8c',
    gray600: '#595959',
    gray700: '#434343',
    gray800: '#262626',
    gray900: '#1f1f1f'
  },
  
  typography: {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    headerSize: '22px',
    headerWeight: '500'
  },
  
  layout: {
    headerGradient: 'linear-gradient(90deg, #1890ff 0%, #722ed1 100%)',
    headerBorder: 'none',
    cardRadius: '8px',
    buttonRadius: '6px'
  },
  
  branding: {
    showServiceIcons: false,
    showGradients: true,
    emphasizeStatus: false
  }
};

// 现代风格主题
const modernTheme = {
  name: 'modern',
  colors: {
    primary: '#6366f1',
    primaryLight: '#818cf8',
    primaryDark: '#4f46e5',
    secondary: '#1f2937',
    secondaryLight: '#374151',
    secondaryDark: '#111827',
    
    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444',
    info: '#3b82f6',
    
    compute: '#8b5cf6',
    storage: '#06b6d4',
    database: '#ec4899',
    ml: '#10b981',
    analytics: '#f59e0b',
    
    gray50: '#f9fafb',
    gray100: '#f3f4f6',
    gray200: '#e5e7eb',
    gray300: '#d1d5db',
    gray400: '#9ca3af',
    gray500: '#6b7280',
    gray600: '#4b5563',
    gray700: '#374151',
    gray800: '#1f2937',
    gray900: '#111827'
  },
  
  typography: {
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    headerSize: '24px',
    headerWeight: '700'
  },
  
  layout: {
    headerGradient: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    headerBorder: 'none',
    cardRadius: '16px',
    buttonRadius: '12px'
  },
  
  branding: {
    showServiceIcons: true,
    showGradients: true,
    emphasizeStatus: true
  }
};

// 经典风格主题
const classicTheme = {
  name: 'classic',
  colors: {
    primary: '#2f54eb',
    primaryLight: '#597ef7',
    primaryDark: '#1d39c4',
    secondary: '#434343',
    secondaryLight: '#595959',
    secondaryDark: '#262626',
    
    success: '#389e0d',
    warning: '#d48806',
    error: '#cf1322',
    info: '#0958d9',
    
    compute: '#2f54eb',
    storage: '#722ed1',
    database: '#c41d7f',
    ml: '#08979c',
    analytics: '#389e0d',
    
    gray50: '#fafafa',
    gray100: '#f5f5f5',
    gray200: '#f0f0f0',
    gray300: '#d9d9d9',
    gray400: '#bfbfbf',
    gray500: '#8c8c8c',
    gray600: '#595959',
    gray700: '#434343',
    gray800: '#262626',
    gray900: '#1f1f1f'
  },
  
  typography: {
    fontFamily: "'Times New Roman', Times, serif",
    headerSize: '22px',
    headerWeight: '600'
  },
  
  layout: {
    headerGradient: 'linear-gradient(90deg, #2f54eb 0%, #722ed1 100%)',
    headerBorder: '2px solid #d9d9d9',
    cardRadius: '4px',
    buttonRadius: '4px'
  },
  
  branding: {
    showServiceIcons: false,
    showGradients: false,
    emphasizeStatus: false
  }
};

// 主题映射
const themes = {
  aws: awsTheme,
  neutral: neutralTheme,
  modern: modernTheme,
  classic: classicTheme
};

// 获取当前激活的主题
export const getActiveTheme = () => {
  return themes[ACTIVE_THEME] || themes.aws;
};

// 获取所有可用主题
export const getAllThemes = () => {
  return Object.keys(themes);
};

// 主题切换说明
export const THEME_DESCRIPTIONS = {
  aws: 'AWS官方风格 - 橙色主题，专业云服务外观',
  neutral: '中性风格 - 蓝紫渐变，通用企业级外观',
  modern: '现代风格 - 紫色主题，时尚科技感外观',
  classic: '经典风格 - 传统蓝色，保守商务外观'
};

// 导出当前主题
export default getActiveTheme();
