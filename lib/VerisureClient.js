'use strict';

const Verisure = require('verisure');

// Endpoint Verisure France (securitasdirect.fr)
// Différent de l'endpoint par défaut (.com) utilisé par le package npm
const FR_HOSTNAME = 'customers.securitasdirect.fr';

/**
 * VerisureClient
 *
 * Wrapper autour du package npm `verisure` adapté pour :
 *  - l'endpoint France (securitasdirect.fr)
 *  - le flow MFA double getToken (SMS one-time code)
 *  - la persistence des cookies dans Homey settings
 *
 * Usage typique (pairing, premier login) :
 *   const client = new VerisureClient({ homey });
 *   await client.initiateLogin(email, password);   // envoie le SMS
 *   await client.confirmMfa(otpCode);              // valide le code
 *   const sensors = await client.getDoorWindowSensors();
 *
 * Usage normal (app déjà configurée) :
 *   const client = VerisureClient.fromSettings({ homey });
 *   const sensors = await client.getDoorWindowSensors();
 */
class VerisureClient {

  /**
   * @param {object} options
   * @param {import('@homeyapp/homey')} options.homey - instance Homey
   * @param {string}  [options.email]    - seulement pour le premier login
   * @param {string}  [options.password] - seulement pour le premier login
   */
  constructor({ homey, email, password }) {
    this.homey = homey;
    this._email = email || null;
    this._password = password || null;
    this._verisure = null;   // instance du package verisure
    this._client = null;     // client installation (GraphQL)
  }

  // ---------------------------------------------------------------------------
  // Factory : recharge les cookies persistés dans Homey settings
  // ---------------------------------------------------------------------------

  /**
   * Crée un client pré-authentifié depuis les cookies stockés dans Homey.
   * Lève une erreur si aucun cookie n'est encore enregistré.
   *
   * @param {{ homey: object }} options
   * @returns {VerisureClient}
   */
  static fromSettings({ homey }) {
    const instance = new VerisureClient({ homey });
    instance._restoreSession();
    return instance;
  }

  // ---------------------------------------------------------------------------
  // Authentification & MFA
  // ---------------------------------------------------------------------------

  /**
   * Étape 1 du flow MFA.
   * Crée l'instance verisure avec l'endpoint FR et envoie le SMS OTP.
   *
   * @param {string} email
   * @param {string} password
   */
  async initiateLogin(email, password) {
    this._email = email;
    this._password = password;

    this._verisure = new Verisure(email, password);

    // Patch de l'hostname pour pointer vers l'endpoint France
    // Le package `verisure` expose sa base URL via this._verisure.hostname
    // ou this._verisure.baseUrl selon la version — on couvre les deux cas.
    if (typeof this._verisure.hostname !== 'undefined') {
      this._verisure.hostname = FR_HOSTNAME;
    }
    if (typeof this._verisure.baseUrl !== 'undefined') {
      this._verisure.baseUrl = `https://${FR_HOSTNAME}`;
    }

    // 1er appel : déclenche l'envoi du SMS, ne retourne pas encore de cookies
    await this._verisure.getToken();

    this.homey.log('[VerisureClient] SMS OTP envoyé à l\'utilisateur');
  }

  /**
   * Étape 2 du flow MFA.
   * Valide le code OTP reçu par SMS et persiste les cookies dans Homey.
   *
   * @param {string} otpCode - code à 6 chiffres reçu par SMS
   */
  async confirmMfa(otpCode) {
    if (!this._verisure) {
      throw new Error('Appelez initiateLogin() avant confirmMfa()');
    }

    // 2e appel : valide le code OTP → retourne vid, vs-access, vs-refresh
    await this._verisure.getToken(otpCode);

    this.homey.log('[VerisureClient] MFA validé — cookies reçus');

    // Persiste les cookies + credentials (pour refresh futur)
    await this._saveSession();

    // Initialise le client GraphQL installation
    await this._initInstallationClient();
  }

  // ---------------------------------------------------------------------------
  // Session & cookies
  // ---------------------------------------------------------------------------

  /**
   * Persiste les cookies et l'email dans les settings Homey (chiffrés).
   * Cookies attendus : vid, vs-access, vs-refresh
   */
  async _saveSession() {
    const cookies = this._verisure.cookies; // tableau de strings "key=value"

    await this.homey.settings.set('verisure_email', this._email);
    await this.homey.settings.set('verisure_cookies', JSON.stringify(cookies));
    await this.homey.settings.set('verisure_session_at', Date.now());

    this.homey.log('[VerisureClient] Session persistée dans Homey settings');
  }

  /**
   * Recharge une session existante depuis les settings Homey.
   * Lève une erreur si aucun cookie n'est enregistré.
   */
  _restoreSession() {
    const email = this.homey.settings.get('verisure_email');
    const cookiesRaw = this.homey.settings.get('verisure_cookies');

    if (!email || !cookiesRaw) {
      throw new Error('Aucune session Verisure enregistrée — veuillez coupler l\'app');
    }

    const cookies = JSON.parse(cookiesRaw);

    // Recréer une instance verisure avec email factice (pas de password nécessaire)
    this._verisure = new Verisure(email, '');

    if (typeof this._verisure.hostname !== 'undefined') {
      this._verisure.hostname = FR_HOSTNAME;
    }
    if (typeof this._verisure.baseUrl !== 'undefined') {
      this._verisure.baseUrl = `https://${FR_HOSTNAME}`;
    }

    // Injecter les cookies directement
    this._verisure.cookies = cookies;
    this._email = email;

    this.homey.log('[VerisureClient] Session restaurée depuis Homey settings');
  }

  /**
   * Efface la session (déconnexion / re-pairing).
   */
  async clearSession() {
    await this.homey.settings.unset('verisure_email');
    await this.homey.settings.unset('verisure_cookies');
    await this.homey.settings.unset('verisure_session_at');
    this._verisure = null;
    this._client = null;
    this.homey.log('[VerisureClient] Session effacée');
  }

  // ---------------------------------------------------------------------------
  // Client GraphQL installation
  // ---------------------------------------------------------------------------

  /**
   * Récupère la liste des installations et initialise le client GraphQL
   * sur la première installation trouvée.
   */
  async _initInstallationClient() {
    const installations = await this._verisure.getInstallations();

    if (!installations || installations.length === 0) {
      throw new Error('Aucune installation Verisure trouvée pour ce compte');
    }

    // On prend la première installation (cas général pour une résidence)
    const installation = installations[0];
    this._client = installation.client.bind(installation);

    this.homey.log(`[VerisureClient] Installation sélectionnée : ${installation.alias || installation.giid}`);
  }

  /**
   * Assure que le client GraphQL est disponible.
   * Si besoin, réinitialise depuis la session restaurée.
   */
  async _ensureClient() {
    if (this._client) return;

    if (!this._verisure) {
      this._restoreSession();
    }

    await this._initInstallationClient();
  }

  /**
   * Exécute une query GraphQL avec gestion 401 + retry unique.
   *
   * @param {object} queryDef - { operationName, query, variables }
   * @returns {object} données GraphQL
   */
  async _query(queryDef) {
    await this._ensureClient();

    try {
      return await this._client(queryDef);
    } catch (err) {
      // 401 → session expirée : on tente un refresh via les cookies vs-refresh
      if (err.statusCode === 401 || (err.message && err.message.includes('401'))) {
        this.homey.log('[VerisureClient] 401 détecté — tentative de refresh session');
        await this._refreshSession();
        return await this._client(queryDef);
      }
      throw err;
    }
  }

  /**
   * Tente de relancer une authentification silencieuse avec les cookies existants.
   * Si ça échoue, notifie Homey qu'un re-pairing est nécessaire.
   */
  async _refreshSession() {
    try {
      this._client = null;
      await this._initInstallationClient();
    } catch (err) {
      this.homey.log('[VerisureClient] Refresh échoué — notification utilisateur');

      // Notification Homey visible dans l'app mobile
      await this.homey.notifications.createNotification({
        excerpt: 'Verisure : session expirée. Ouvrez les réglages de l\'app pour vous reconnecter.',
      });

      throw new Error('Session Verisure expirée — reconnexion requise');
    }
  }

  // ---------------------------------------------------------------------------
  // Queries métier
  // ---------------------------------------------------------------------------

  /**
   * Retourne l'état de tous les capteurs de contact (portes/fenêtres).
   *
   * @returns {Promise<Array<{
   *   deviceLabel: string,
   *   area: string,
   *   state: 'OPEN' | 'CLOSED',
   *   reportTime: string
   * }>>}
   */
  async getDoorWindowSensors() {
    const result = await this._query({
      operationName: 'DoorWindow',
      query: `
        query DoorWindow($giid: String!) {
          installation(giid: $giid) {
            doorWindows {
              deviceLabel
              area
              state
              reportTime
              __typename
            }
            __typename
          }
        }
      `,
    });

    const sensors = result?.installation?.doorWindows ?? [];
    this.homey.log(`[VerisureClient] ${sensors.length} capteur(s) contact récupéré(s)`);
    return sensors;
  }

  /**
   * Retourne l'état courant de l'alarme.
   *
   * @returns {Promise<{
   *   armState: 'ARMED_AWAY' | 'ARMED_HOME' | 'DISARMED',
   *   changedVia: string,
   *   date: string
   * }>}
   */
  async getArmState() {
    const result = await this._query({
      operationName: 'ArmState',
      query: `
        query ArmState($giid: String!) {
          installation(giid: $giid) {
            armState {
              type
              statusType
              date
              changedVia
              __typename
            }
            __typename
          }
        }
      `,
    });

    const armState = result?.installation?.armState ?? null;
    this.homey.log(`[VerisureClient] État alarme : ${armState?.statusType}`);
    return armState;
  }

  /**
   * Retourne un snapshot complet : capteurs + état alarme en une seule requête.
   * Utilisé par le poller pour limiter le nombre d'appels API.
   *
   * @returns {Promise<{ doorWindows: Array, armState: object }>}
   */
  async getFullSnapshot() {
    const result = await this._query({
      operationName: 'FullSnapshot',
      query: `
        query FullSnapshot($giid: String!) {
          installation(giid: $giid) {
            doorWindows {
              deviceLabel
              area
              state
              reportTime
              __typename
            }
            armState {
              statusType
              date
              changedVia
              __typename
            }
            cameras {
              deviceLabel
              area
              online
              imageCaptureAllowed
              latestDetection
              __typename
            }
            __typename
          }
        }
      `,
    });

    return {
      doorWindows:   result?.installation?.doorWindows ?? [],
      armState:      result?.installation?.armState    ?? null,
      motionSensors: result?.installation?.cameras     ?? [],
    };
  }

  // ---------------------------------------------------------------------------
  // Queries caméra / détecteur PIR (GuardVision)
  // ---------------------------------------------------------------------------

  /**
   * Retourne la liste de toutes les SmartCam / GuardVision (PIR avec caméra).
   *
   * @returns {Promise<Array<{
   *   deviceLabel: string,
   *   area: string,
   *   online: boolean,
   *   imageCaptureAllowed: boolean
   * }>>}
   */
  async getSmartCams() {
    const result = await this._query({
      operationName: 'SmartCams',
      query: `
        query SmartCams($giid: String!) {
          installation(giid: $giid) {
            cameras {
              deviceLabel
              area
              online
              imageCaptureAllowed
              __typename
            }
            __typename
          }
        }
      `,
    });

    const cams = result?.installation?.cameras ?? [];
    this.homey.log(`[VerisureClient] ${cams.length} caméra(s) PIR récupérée(s)`);
    return cams;
  }

  /**
   * Étape 1 de la capture : obtenir un requestId.
   * Doit être appelé immédiatement avant captureImage().
   *
   * @param {string} deviceLabel
   * @returns {Promise<string>} requestId
   */
  async getCameraRequestId(deviceLabel) {
    const result = await this._query({
      operationName: 'CameraRequestId',
      query: `
        query CameraRequestId($giid: String!, $deviceLabel: String!) {
          installation(giid: $giid) {
            cameraRequestId(deviceLabel: $deviceLabel)
            __typename
          }
        }
      `,
      variables: { deviceLabel },
    });

    const requestId = result?.installation?.cameraRequestId;
    if (!requestId) throw new Error(`[VerisureClient] Impossible d'obtenir un requestId pour ${deviceLabel}`);

    this.homey.log(`[VerisureClient] requestId obtenu pour ${deviceLabel} : ${requestId}`);
    return requestId;
  }

  /**
   * Étape 2 de la capture : déclencher la prise de photo.
   * L'image est disponible dans le cloud Verisure après 3–5 secondes.
   *
   * @param {string} deviceLabel
   * @param {string} requestId — obtenu via getCameraRequestId()
   * @returns {Promise<boolean>} true si la commande a été acceptée
   */
  async captureImage(deviceLabel, requestId) {
    const result = await this._query({
      operationName: 'CameraCapture',
      query: `
        mutation CameraCapture($giid: String!, $deviceLabel: String!, $requestId: String!) {
          installation(giid: $giid) {
            cameraCapture(deviceLabel: $deviceLabel, requestId: $requestId)
            __typename
          }
        }
      `,
      variables: { deviceLabel, requestId },
    });

    const ok = !!result?.installation?.cameraCapture;
    this.homey.log(`[VerisureClient] Capture déclenchée pour ${deviceLabel} : ${ok}`);
    return ok;
  }

  /**
   * Récupère la dernière image disponible pour une caméra.
   * Appeler après captureImage() avec un délai de 3–5 secondes.
   *
   * @param {string} deviceLabel
   * @returns {Promise<{ deviceLabel: string, captureTime: string, contentType: string, imageUrl: string } | null>}
   */
  async getLastCameraImage(deviceLabel) {
    const result = await this._query({
      operationName: 'CameraLastImage',
      query: `
        query CameraLastImage($giid: String!, $deviceLabel: String!) {
          installation(giid: $giid) {
            cameraLastImage(deviceLabel: $deviceLabel) {
              deviceLabel
              captureTime
              contentType
              imageUrl
              __typename
            }
            __typename
          }
        }
      `,
      variables: { deviceLabel },
    });

    return result?.installation?.cameraLastImage ?? null;
  }

  /**
   * Récupère les N dernières images d'une caméra (série).
   *
   * @param {string} deviceLabel
   * @returns {Promise<Array<{ captureTime: string, contentType: string, imageUrl: string }>>}
   */
  async getCameraImageSeries(deviceLabel) {
    const result = await this._query({
      operationName: 'CameraImageSeries',
      query: `
        query CameraImageSeries($giid: String!, $deviceLabel: String!) {
          installation(giid: $giid) {
            cameraImageSeries(deviceLabel: $deviceLabel) {
              deviceLabel
              captureTime
              contentType
              imageUrl
              __typename
            }
            __typename
          }
        }
      `,
      variables: { deviceLabel },
    });

    return result?.installation?.cameraImageSeries ?? [];
  }

  /**
   * Télécharge le binaire d'une image depuis son URL signée Verisure.
   * Retourne un Buffer utilisable avec homey.images.createImage().
   *
   * @param {string} imageUrl — URL retournée par getLastCameraImage()
   * @returns {Promise<Buffer>}
   */
  async downloadImage(imageUrl) {
    const fetch = require('node-fetch');
    const res = await fetch(imageUrl, {
      headers: { Cookie: this._verisure.cookies.join('; ') },
    });

    if (!res.ok) {
      throw new Error(`[VerisureClient] Téléchargement image échoué : ${res.status}`);
    }

    const buffer = await res.buffer();
    this.homey.log(`[VerisureClient] Image téléchargée : ${buffer.length} octets`);
    return buffer;
  }

  /**
   * Workflow complet en une seule méthode :
   * requestId → capture → attente → récupération image.
   *
   * @param {string} deviceLabel
   * @param {number} [waitMs=4000] — délai avant récupération (ms)
   * @returns {Promise<{ imageUrl: string, captureTime: string, contentType: string } | null>}
   */
  async captureAndFetch(deviceLabel, waitMs = 4000) {
    const requestId = await this.getCameraRequestId(deviceLabel);
    await this.captureImage(deviceLabel, requestId);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    return this.getLastCameraImage(deviceLabel);
  }

  // ---------------------------------------------------------------------------
  // Utilitaires
  // ---------------------------------------------------------------------------

  /**
   * Normalise l'état d'un capteur contact vers la capability Homey alarm_contact.
   * @param {'OPEN'|'CLOSED'} state
   * @returns {boolean} true = ouvert (alarme), false = fermé (ok)
   */
  static toAlarmContact(state) {
    return state === 'OPEN';
  }

  /**
   * Normalise l'état de l'alarme vers la capability Homey homealarm_state.
   * @param {'ARMED_AWAY'|'ARMED_HOME'|'DISARMED'} statusType
   * @returns {'armed'|'partially_armed'|'disarmed'}
   */
  static toHomeyAlarmState(statusType) {
    switch (statusType) {
      case 'ARMED_AWAY':  return 'armed';
      case 'ARMED_HOME':  return 'partially_armed';
      case 'DISARMED':    return 'disarmed';
      default:            return 'disarmed';
    }
  }

}

module.exports = VerisureClient;
