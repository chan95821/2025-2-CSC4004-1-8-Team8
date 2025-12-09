import { atom } from 'recoil';

const toolMode = atom<string>({
  key: 'toolMode',
  default: '',
});

export default { toolMode };
