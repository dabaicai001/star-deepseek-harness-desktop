<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useThemeStore } from '@/stores/theme'

const { t, locale } = useI18n()
const themeStore = useThemeStore()
</script>

<template>
  <v-container>
    <v-row>
      <v-col cols="12">
        <h1>{{ t('settings.title') }}</h1>
      </v-col>
    </v-row>
    <v-row>
      <v-col cols="12" md="6">
        <v-card>
          <v-card-title>{{ t('settings.appearance') }}</v-card-title>
          <v-card-text>
            <v-list>
              <v-list-item>
                <template v-slot:prepend>
                  <v-icon>mdi-theme-light-dark</v-icon>
                </template>
                <v-list-item-title>{{ t('settings.theme') }}</v-list-item-title>
                <template v-slot:append>
                  <v-btn-toggle v-model="themeStore.theme" mandatory>
                    <v-btn value="lightTheme" size="small">
                      <v-icon>mdi-weather-sunny</v-icon>
                    </v-btn>
                    <v-btn value="darkTheme" size="small">
                      <v-icon>mdi-weather-night</v-icon>
                    </v-btn>
                  </v-btn-toggle>
                </template>
              </v-list-item>
              <v-list-item>
                <template v-slot:prepend>
                  <v-icon>mdi-translate</v-icon>
                </template>
                <v-list-item-title>{{ t('settings.language') }}</v-list-item-title>
                <template v-slot:append>
                  <v-btn-toggle v-model="locale" mandatory>
                    <v-btn value="zh-CN" size="small">中文</v-btn>
                    <v-btn value="en-US" size="small">English</v-btn>
                  </v-btn-toggle>
                </template>
              </v-list-item>
            </v-list>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>
