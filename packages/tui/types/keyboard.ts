export interface Key {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  option: boolean;
  sequence: string;
}

export interface Shortcut {
  key: string;
  description: string;
  disabled?: boolean;
}

export interface ShortcutGroup {
  shortcuts: Shortcut[];
}
