import { BottleStatus } from '../types/sake';

export const STATUS_LABELS: Record<BottleStatus, string> = {
  unopened: '未開封',
  opened: '開封済み',
  finished: '飲み切り',
  disposed: '手放した',
};
