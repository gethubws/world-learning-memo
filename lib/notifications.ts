import { toast as manager } from '@/components/ui/toast';
export const toast = {
  success: (title: string) => manager.add({ title, type: 'success' }),
  error: (title: string) =>
    manager.add({ title, type: 'error', timeout: 9000 }),
  warning: (title: string) =>
    manager.add({ title, type: 'warning', timeout: 9000 }),
  info: (title: string) => manager.add({ title, type: 'info' }),
};
