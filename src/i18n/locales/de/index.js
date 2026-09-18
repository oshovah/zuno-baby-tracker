import { buildLocale } from '../../build.js';
import meta from './meta.js';
import common from './common.js';
import shell from './shell.js';
import home from './home.js';
import history from './history.js';
import more from './more.js';
import login from './login.js';
import authInfo from './authInfo.js';
import howto from './howto.js';
import forms from './forms.js';
import errors from './errors.js';
import api from './api.js';

export default buildLocale(meta, { common, shell, home, history, more, login, authInfo, howto, forms, errors, api });
