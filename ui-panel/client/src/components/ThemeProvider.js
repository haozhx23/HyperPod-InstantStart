import React, { useEffect, useState } from 'react';
import { ConfigProvider, theme as antdTheme } from 'antd';
import { getActiveTheme, COLOR_SCHEME_MODE } from '../config/themeConfig';

const useColorScheme = () => {
  const [isDark, setIsDark] = useState(() => {
    if (COLOR_SCHEME_MODE === 'light') return false;
    if (COLOR_SCHEME_MODE === 'dark') return true;
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    if (COLOR_SCHEME_MODE !== 'auto') return undefined;
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e) => setIsDark(e.matches);
    if (mq.addEventListener) {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);

  return isDark;
};

const darkGrayPalette = {
  gray50: '#141414',
  gray100: '#1f1f1f',
  gray200: '#2a2a2a',
  gray300: '#3a3a3a',
  gray400: '#5a5a5a',
  gray500: '#7a7a7a',
  gray600: '#9a9a9a',
  gray700: '#bfbfbf',
  gray800: '#d9d9d9',
  gray900: '#f0f0f0',
};

const ThemeProvider = ({ children }) => {
  const theme = getActiveTheme();
  const isDark = useColorScheme();

  useEffect(() => {
    const root = document.documentElement;

    const effectiveColors = isDark
      ? { ...theme.colors, ...darkGrayPalette }
      : theme.colors;

    Object.entries(effectiveColors).forEach(([key, value]) => {
      root.style.setProperty(`--theme-${key}`, value);
    });

    root.style.setProperty('--theme-surface', isDark ? '#1f1f1f' : '#ffffff');
    root.style.setProperty('--theme-surface-elevated', isDark ? '#262626' : '#ffffff');
    root.style.setProperty('--theme-border', isDark ? '#303030' : effectiveColors.gray200);

    root.style.setProperty('--theme-font-family', theme.typography.fontFamily);
    root.style.setProperty('--theme-header-size', theme.typography.headerSize);
    root.style.setProperty('--theme-header-weight', theme.typography.headerWeight);

    root.style.setProperty('--theme-header-gradient', theme.layout.headerGradient);
    root.style.setProperty('--theme-header-border', theme.layout.headerBorder);
    root.style.setProperty('--theme-card-radius', theme.layout.cardRadius);
    root.style.setProperty('--theme-button-radius', theme.layout.buttonRadius);

    root.style.setProperty('--theme-show-service-icons', theme.branding.showServiceIcons ? '1' : '0');
    root.style.setProperty('--theme-show-gradients', theme.branding.showGradients ? '1' : '0');
    root.style.setProperty('--theme-emphasize-status', theme.branding.emphasizeStatus ? '1' : '0');

    root.setAttribute('data-theme-mode', isDark ? 'dark' : 'light');
    root.style.colorScheme = isDark ? 'dark' : 'light';

    document.body.className = document.body.className.replace(/theme-\w+/g, '');
    document.body.classList.add(`theme-${theme.name}`);
    document.body.classList.toggle('theme-dark', isDark);
  }, [theme, isDark]);

  const effectiveColors = isDark
    ? { ...theme.colors, ...darkGrayPalette }
    : theme.colors;

  const antdThemeConfig = {
    algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: theme.colors.primary,
      colorSuccess: theme.colors.success,
      colorWarning: theme.colors.warning,
      colorError: theme.colors.error,
      colorInfo: theme.colors.info,
      fontFamily: theme.typography.fontFamily,
      borderRadius: parseInt(theme.layout.cardRadius),
    },
    components: {
      Layout: {
        headerBg: 'transparent',
        headerHeight: 64,
        headerPadding: '0 24px',
      },
      Card: {
        borderRadius: parseInt(theme.layout.cardRadius),
        headerBg: isDark ? '#1f1f1f' : theme.colors.gray50,
      },
      Button: {
        borderRadius: parseInt(theme.layout.buttonRadius),
        primaryShadow: `0 2px 4px ${theme.colors.primary}20`,
      },
      Table: {
        headerBg: isDark ? '#262626' : theme.colors.gray100,
        headerColor: isDark ? effectiveColors.gray800 : theme.colors.gray800,
        borderColor: isDark ? '#303030' : theme.colors.gray200,
      },
      Tabs: {
        inkBarColor: theme.colors.primary,
        itemActiveColor: theme.colors.primary,
        itemHoverColor: theme.colors.primaryLight,
      },
    },
  };

  return (
    <ConfigProvider theme={antdThemeConfig}>
      {children}
    </ConfigProvider>
  );
};

export default ThemeProvider;
