import type { Drawer } from '../types';
import { AccountDrawer } from './AccountDrawer';
import { BackupsDrawer } from './BackupsDrawer';
import { ConnectDrawer } from './ConnectDrawer';
import { CronDrawer } from './CronDrawer';
import { FunctionsDrawer } from './FunctionsDrawer';
import { InternetDrawer } from './InternetDrawer';
import { NewTableDrawer } from './NewTableDrawer';
import { ServiceDrawer } from './ServiceDrawer';
import { SettingsDrawer } from './SettingsDrawer';
import { SqlDrawer } from './SqlDrawer';
import { StorageDrawer } from './StorageDrawer';
import { TableDrawer } from './TableDrawer';
import { UsersDrawer } from './UsersDrawer';

export function DrawerHost({ drawer }: { drawer: Drawer }) {
  switch (drawer.kind) {
    case 'table':
      return <TableDrawer key={drawer.table} table={drawer.table} />;
    case 'sql':
      return <SqlDrawer initial={drawer.sql} />;
    case 'users':
      return <UsersDrawer />;
    case 'storage':
      return <StorageDrawer />;
    case 'functions':
      return <FunctionsDrawer initial={drawer.fn} />;
    case 'service':
      return <ServiceDrawer key={drawer.service} service={drawer.service} />;
    case 'connect':
      return <ConnectDrawer />;
    case 'internet':
      return <InternetDrawer />;
    case 'backups':
      return <BackupsDrawer />;
    case 'cron':
      return <CronDrawer />;
    case 'new-table':
      return <NewTableDrawer />;
    case 'settings':
      return <SettingsDrawer focus={drawer.focus} />;
    case 'account':
      return <AccountDrawer />;
  }
}
