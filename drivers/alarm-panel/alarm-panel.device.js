'use strict';

const { Device } = require('homey');
const VerisureClient = require('../../lib/VerisureClient');

/**
 * AlarmPanelDevice
 *
 * Représente la centrale d'alarme Verisure dans Homey (device unique).
 *
 * Capabilities déclarées dans app.json :
 *   - homealarm_state  (enum)    — 'armed' | 'partially_armed' | 'disarmed'
 *   - alarm_generic    (boolean) — true = alarme déclenchée en cours
 *
 * Comme ContactSensorDevice, ce device ne poll pas lui-même.
 * Il s'abonne aux events du VerisurePoller central géré par app.js.
 */
class AlarmPanelDevice extends Device {

  // ---------------------------------------------------------------------------
  // Cycle de vie Homey
  // ---------------------------------------------------------------------------

  async onInit() {
    this.log('[AlarmPanel] Init');

    // Liaison des handlers pour pouvoir les détacher proprement dans onDeleted
    this._onAlarmChanged    = this._onAlarmChanged.bind(this);
    this._onSessionExpired  = this._onSessionExpired.bind(this);

    this.homey.app.poller.on('alarm.changed',   this._onAlarmChanged);
    this.homey.app.poller.on('session.expired', this._onSessionExpired);

    // Enregistrement de la condition Flow "is_alarm_armed"
    this._registerFlowCondition();

    // Sync depuis le cache poller au démarrage
    await this._syncFromCache();

    this.log('[AlarmPanel] Prêt');
  }

  async onDeleted() {
    this.log('[AlarmPanel] Suppression');

    if (this.homey.app.poller) {
      this.homey.app.poller.off('alarm.changed',   this._onAlarmChanged);
      this.homey.app.poller.off('session.expired', this._onSessionExpired);
    }
  }

  // ---------------------------------------------------------------------------
  // Sync depuis le cache du poller
  // ---------------------------------------------------------------------------

  async _syncFromCache() {
    const status = this.homey.app.poller.getStatus();

    if (!status.lastArmState) {
      this.log('[AlarmPanel] Pas encore de cache, en attente du premier poll');
      return;
    }

    const homeyState = VerisureClient.toHomeyAlarmState(status.lastArmState);
    await this._setAlarmState(homeyState, { silent: true });
    this.log(`[AlarmPanel] État initialisé depuis cache : ${status.lastArmState}`);
  }

  // ---------------------------------------------------------------------------
  // Handlers d'événements poller
  // ---------------------------------------------------------------------------

  /**
   * @param {{ statusType: string, homeyState: string, previous: string, date: string, changedVia: string }} event
   */
  async _onAlarmChanged(event) {
    this.log(`[AlarmPanel] Changement état : ${event.previous} → ${event.statusType}`);
    await this._setAlarmState(event.homeyState, { silent: false, event });
  }

  async _onSessionExpired() {
    this.log('[AlarmPanel] Session expirée — device indisponible');
    await this.setUnavailable(this.homey.__('error.session_expired'));
  }

  // ---------------------------------------------------------------------------
  // Mise à jour des capabilities
  // ---------------------------------------------------------------------------

  /**
   * @param {'armed'|'partially_armed'|'disarmed'} homeyState
   * @param {{ silent: boolean, event?: object }} options
   */
  async _setAlarmState(homeyState, { silent = false, event = null } = {}) {
    try {
      const current = this.getCapabilityValue('homealarm_state');
      if (current === homeyState) return;

      await this.setCapabilityValue('homealarm_state', homeyState);

      // Remettre disponible si besoin
      if (!this.getAvailable()) {
        await this.setAvailable();
      }

      if (!silent && event) {
        await this._triggerFlows(homeyState, event);
      }

    } catch (err) {
      this.error('[AlarmPanel] Erreur setCapabilityValue :', err.message);
    }
  }

  /**
   * Met à jour alarm_generic (alarme en cours).
   * @param {boolean} triggered
   */
  async _setAlarmTriggered(triggered) {
    try {
      const current = this.getCapabilityValue('alarm_generic');
      if (current === triggered) return;
      await this.setCapabilityValue('alarm_generic', triggered);
    } catch (err) {
      this.error('[AlarmPanel] Erreur alarm_generic :', err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Flow triggers
  // ---------------------------------------------------------------------------

  async _triggerFlows(homeyState, event) {
    try {
      const tokens = {
        state:      homeyState,
        changed_via: event.changedVia || '',
      };

      // Trigger "alarm_triggered" si l'alarme vient de se déclencher
      // (cas particulier : l'API Verisure peut retourner un status ALARM)
      if (event.statusType === 'ALARM') {
        await this._setAlarmTriggered(true);
        await this.driver.triggerAlarmTriggered(this, tokens);
        this.log('[AlarmPanel] Flow "alarm_triggered" déclenché');
      } else {
        // Remettre alarm_generic à false dès que l'état change (alarme stoppée)
        await this._setAlarmTriggered(false);
      }

    } catch (err) {
      this.error('[AlarmPanel] Erreur Flow trigger :', err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Flow condition
  // ---------------------------------------------------------------------------

  _registerFlowCondition() {
    const condition = this.homey.flow.getConditionCard('is_alarm_armed');

    condition.registerRunListener(async ({ device }) => {
      const state = device.getCapabilityValue('homealarm_state');
      // La condition est vraie si armé (total ou partiel)
      return state === 'armed' || state === 'partially_armed';
    });

    this.log('[AlarmPanel] Condition Flow "is_alarm_armed" enregistrée');
  }

  // ---------------------------------------------------------------------------
  // Settings & renommage
  // ---------------------------------------------------------------------------

  async onSettings({ changedKeys }) {
    this.log('[AlarmPanel] Settings modifiés :', changedKeys);
  }

  async onRenamed(name) {
    this.log(`[AlarmPanel] Renommé en : ${name}`);
  }

}

module.exports = AlarmPanelDevice;
