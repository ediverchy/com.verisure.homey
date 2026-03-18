'use strict';

const { Driver } = require('homey');
const VerisureClient = require('../../lib/VerisureClient');

/**
 * PirCameraDriver
 *
 * Driver pour le détecteur PIR avec caméra Verisure (GuardVision / SmartCam).
 *
 * Flow cards déclarées dans app.json :
 *   triggers  : motion_detected, image_captured
 *   conditions: —
 *   actions   : capture_image
 */
class PirCameraDriver extends Driver {

  async onInit() {
    this.log('[PirCameraDriver] Init');

    // Trigger : mouvement détecté (via polling état + event log)
    this._triggerMotionDetected = this.homey.flow.getDeviceTriggerCard('motion_detected');

    // Trigger : nouvelle image capturée (après action ou mouvement)
    this._triggerImageCaptured  = this.homey.flow.getDeviceTriggerCard('image_captured');

    // Action : déclencher une capture depuis un Flow
    const captureAction = this.homey.flow.getActionCard('capture_image');
    captureAction.registerRunListener(async ({ device }) => {
      return device.triggerCapture();
    });

    this.log('[PirCameraDriver] Flow cards enregistrées');
  }

  // ---------------------------------------------------------------------------
  // Helpers Flow — appelés depuis PirCameraDevice
  // ---------------------------------------------------------------------------

  async triggerMotionDetected(device, tokens) {
    await this._triggerMotionDetected.trigger(device, tokens);
  }

  async triggerImageCaptured(device, tokens) {
    await this._triggerImageCaptured.trigger(device, tokens);
  }

  // ---------------------------------------------------------------------------
  // Pairing
  // ---------------------------------------------------------------------------

  async onPairListDevices() {
    this.log('[PirCameraDriver] Récupération caméras PIR...');

    const client = VerisureClient.fromSettings({ homey: this.homey });
    const cameras = await client.getSmartCams();

    if (!cameras.length) {
      throw new Error(this.homey.__('error.no_cameras_found'));
    }

    const existingLabels = new Set(
      this.getDevices().map(d => d.getSetting('deviceLabel'))
    );

    const newDevices = cameras
      .filter(c => !existingLabels.has(c.deviceLabel))
      .map(cam => ({
        name: cam.area || cam.deviceLabel,
        data: { id: cam.deviceLabel },
        settings: {
          deviceLabel:          cam.deviceLabel,
          area:                 cam.area || '',
          imageCaptureAllowed:  cam.imageCaptureAllowed ?? true,
        },
        capabilities: ['alarm_motion', 'homey:manager:images'],
      }));

    this.log(`[PirCameraDriver] ${newDevices.length} caméra(s) PIR disponible(s)`);
    return newDevices;
  }

  onPair(session) {
    session.setHandler('list_devices', async () => this.onPairListDevices());
  }

}

module.exports = PirCameraDriver;
