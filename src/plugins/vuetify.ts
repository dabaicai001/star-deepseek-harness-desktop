import 'vuetify/styles'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import '@mdi/font/css/materialdesignicons.css'

const darkTheme = {
  dark: true,
  colors: {
    background: '#050810',
    surface: '#0a0e1a',
    'surface-bright': '#141928',
    'surface-variant': '#0f1420',
    primary: '#00f0ff',
    'primary-darken-1': '#00c0cc',
    secondary: '#b56bff',
    'secondary-darken-1': '#9050cc',
    error: '#ff4d6d',
    info: '#00f0ff',
    success: '#4ade80',
    warning: '#facc15',
    'on-background': '#e8efff',
    'on-surface': '#e8efff',
    'on-primary': '#050810',
    'on-secondary': '#050810',
  },
  variables: {
    'border-color': 'rgba(120, 160, 255, 0.15)',
    'border-opacity': 0.15,
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
    background: '#f5f7ff',
    surface: '#ffffff',
    'surface-bright': '#ffffff',
    'surface-variant': '#eef1fa',
    primary: '#0891b2',
    'primary-darken-1': '#0e7490',
    secondary: '#7c3aed',
    'secondary-darken-1': '#6d28d9',
    error: '#e11d48',
    info: '#0891b2',
    success: '#16a34a',
    warning: '#ca8a04',
    'on-background': '#0f172a',
    'on-surface': '#0f172a',
    'on-primary': '#ffffff',
    'on-secondary': '#ffffff',
  },
  variables: {
    'border-color': 'rgba(15, 23, 42, 0.12)',
    'border-opacity': 0.12,
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
