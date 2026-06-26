import 'vuetify/styles'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import '@mdi/font/css/materialdesignicons.css'

const darkTheme = {
  dark: true,
  colors: {
    background: '#080d14',
    surface: '#0d1420',
    'surface-bright': '#152032',
    'surface-variant': '#101822',
    primary: '#5dd6d6',
    'primary-darken-1': '#42b9bd',
    secondary: '#8f7bd8',
    'secondary-darken-1': '#7666c9',
    error: '#ee6b7a',
    info: '#5dd6d6',
    success: '#6fd28a',
    warning: '#e2bf5a',
    'on-background': '#dce7f3',
    'on-surface': '#dce7f3',
    'on-primary': '#080d14',
    'on-secondary': '#080d14',
  },
  variables: {
    'border-color': 'rgba(122, 156, 185, 0.18)',
    'border-opacity': 0.18,
    'high-emphasis-opacity': 0.87,
    'medium-emphasis-opacity': 0.60,
    'disabled-opacity': 0.38,
    'idle-opacity': 0.04,
    'hover-opacity': 0.06,
    'focus-opacity': 0.12,
    'selected-opacity': 0.08,
    'activated-opacity': 0.12,
    'pressed-opacity': 0.12,
    'dragged-opacity': 0.08,
  }
}

const lightTheme = {
  dark: false,
  colors: {
    background: '#f4f7fa',
    surface: '#ffffff',
    'surface-bright': '#ffffff',
    'surface-variant': '#e9eef4',
    primary: '#3f6f7a',
    'primary-darken-1': '#345d67',
    secondary: '#6d6598',
    'secondary-darken-1': '#5b5484',
    error: '#be4d5f',
    info: '#3f6f7a',
    success: '#3f7f54',
    warning: '#9b7a28',
    'on-background': '#0f172a',
    'on-surface': '#0f172a',
    'on-primary': '#ffffff',
    'on-secondary': '#ffffff',
  },
  variables: {
    'border-color': 'rgba(30, 45, 62, 0.13)',
    'border-opacity': 0.13,
  }
}

export default createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: 'darkTheme',
    themes: {
      darkTheme,
      lightTheme,
    },
  },
})
