import 'vuetify/styles'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import '@mdi/font/css/materialdesignicons.css'

const lightTheme = {
  dark: false,
  colors: {
    background: '#f7f5f0',
    surface: '#ffffff',
    primary: '#2f6f5e',
    'primary-dark': '#1f4e42',
    secondary: '#c97b3f',
    error: '#ce422b',
    info: '#00add8',
    success: '#42b883',
    warning: '#ffc131'
  }
}

const darkTheme = {
  dark: true,
  colors: {
    background: '#1a1a2e',
    surface: '#16213e',
    primary: '#4a9e8a',
    'primary-dark': '#2f6f5e',
    secondary: '#e0955f',
    error: '#ff6b6b',
    info: '#48dbfb',
    success: '#00d2d3',
    warning: '#feca57'
  }
}

export default createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: 'lightTheme',
    themes: {
      lightTheme,
      darkTheme
    }
  }
})
