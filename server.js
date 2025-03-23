
const ari = require('ari-client');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { TranscribeStreamingClient, StartStreamTranscriptionCommand } = require('@aws-sdk/client-transcribe-streaming');
const app = express();
require('dotenv').config();

app.use(express.json());

const ariConfig = {
  url: process.env.ARI_URL || 'http://localhost:8088',
  username: process.env.ARI_USERNAME || 'asterisk',
  password: process.env.ARI_PASSWORD || 'asterisk'
};

class TwoWayController {
  constructor() {
    this.client = null;
    this.activeBridges = new Map();
    this.isShuttingDown = false;
    this.pendingChannels = new Map();
    this.transcriptionSessions = new Map();
  }

  async init() {
    console.log(Connecting to ARI at ${ariConfig.url});
    this.client = await ari.connect(ariConfig.url, ariConfig.username, ariConfig.password);
    console.log('Connected to Asterisk ARI');
    this.client.on('StasisStart', (event, channel) => this.onStasisStart(event, channel));
    this.client.on('StasisEnd', (event, channel) => this.onStasisEnd(event, channel));
    this.client.on('ChannelStateChange', (event) => this.onChannelStateChange(event));
    this.client.start('audio-control');
  }

  async onChannelStateChange(event) {
    const channel = event.channel;
    console.log(Channel ${channel.id} state changed to ${channel.state});
    
    if (channel.state === 'Up' && this.pendingChannels.has(channel.id)) {
      const bridgeId = this.pendingChannels.get(channel.id);
      console.log(Channel ${channel.id} is now Up and ready for bridge ${bridgeId});
      
      const bridgeData = this.activeBridges.get(bridgeId);
      if (bridgeData && !bridgeData.terminating) {
        this.completeCallSetup(bridgeId);
      }
    }
  }

  async completeCallSetup(bridgeId) {
    const bridgeData = this.activeBridges.get(bridgeId);
    if (!bridgeData || bridgeData.channelsAdded || bridgeData.terminating) return;

    bridgeData.channelsAdded = true;
    
    const { bridge, inboundChannel, fixedPstnChannel } = bridgeData;
    
    try {
      await bridge.addChannel({ channel: [inboundChannel, fixedPstnChannel] });
      console.log(Added both channels to bridge ${bridgeId} after Fixed PSTN fully answered);
      
      try {
        await this.playAudio(bridgeId, 'silence/1', 'all');
        console.log(Initialized audio paths for bridge ${bridgeId});
      } catch (audioErr) {
        console.warn(Failed to initialize audio paths: ${audioErr.message});
      }
      
      this.pendingChannels.delete(fixedPstnChannel);
    } catch (err) {
      console.error(Error completing call setup for bridge ${bridgeId}: ${err.message});
    }
  }

  async onStasisStart(event, channel) {
    console.log(Channel ${channel.id} entered Stasis with args:, event.args);
    try {
      if (event.args.length === 0) {
        await this.handleInboundCall(channel);
      } else if (event.args.length === 2 && event.args[0] === 'outbound') {
        const pstnNumber = event.args[1];
        await this.handleOutboundCall(channel, pstnNumber);
      } else if (event.args.length === 2 && event.args[0] === 'callee') {
        const bridgeId = event.args[1];
        await this.handleCalleeLeg(channel, bridgeId);
      } else if (event.args.length === 1 && event.args[0] === 'whisper-playback') {
        console.log(Whisper playback channel ${channel.id} started);
        await channel.answer();
      } else if (event.args.length === 1 && event.args[0] === 'transcribe') {
        console.log(Transcription channel ${channel.id} started);
        await channel.answer();
      } else {
        console.warn(Unhandled scenario for channel ${channel.id} =>, event.args);
        await channel.hangup();
      }
    } catch (err) {
      console.error(Error in onStasisStart for channel ${channel.id}:, err);
      await channel.hangup();
    }
  }

  async handleInboundCall(inboundChannel) {
    console.log(Inbound call from channel ${inboundChannel.id});
    try {
      await inboundChannel.answer();
      
      const bridge = await this.client.bridges.create({ type: 'mixing' });
      console.log(Created bridge ${bridge.id} for inbound call);
      
      this.activeBridges.set(bridge.id, {
        bridge,
        inboundChannel: inboundChannel.id,
        fixedPstnChannel: null,
        pstnChannel: inboundChannel.id,
        terminating: false,
        channelsAdded: false
      });
      
      const fixedPstnNumber = '+917207327116';
      
      await inboundChannel.play({ media: 'sound:queue-thankyou' });
      
      try {
        const pstnChannel = await this.originateChannel(fixedPstnNumber, bridge.id);
        
        const updatedBridgeData = this.activeBridges.get(bridge.id);
        if (!updatedBridgeData) {
          console.warn(Bridge ${bridge.id} no longer exists after PSTN origination);
          if (pstnChannel) await pstnChannel.hangup();
          return;
        }
        
        updatedBridgeData.fixedPstnChannel = pstnChannel.id;
        
        this.pendingChannels.set(pstnChannel.id, bridge.id);
        
      } catch (err) {
        console.error(Error originating call to fixed PSTN: ${err.message});
        await inboundChannel.play({ media: 'sound:call-failed' });
        setTimeout(() => inboundChannel.hangup(), 3000);
      }
    } catch (err) {
      console.error(Error in handleInboundCall:, err);
      try {
        await inboundChannel.hangup();
      } catch (hangupErr) {
        console.error(Error hanging up inbound channel:, hangupErr);
      }
    }
  }

  async handleOutboundCall(callingChannel, pstnNumber) {
    console.log(Outbound call from channel ${callingChannel.id} to PSTN ${pstnNumber});
    
    const fixedPstnNumber = '+917207327116';
    if (pstnNumber === fixedPstnNumber) {
      console.error(Cannot call the fixed PSTN number ${fixedPstnNumber} as the second party);
      await callingChannel.hangup();
      return;
    }
    
    await callingChannel.answer();
    
    const bridge = await this.client.bridges.create({ type: 'mixing' });
    console.log(Created bridge ${bridge.id} for outbound call);
    
    this.activeBridges.set(bridge.id, {
      bridge,
      pstnChannel: callingChannel.id,
      fixedPstnChannel: null,
      terminating: false,
      channelsAdded: false
    });
    
    await callingChannel.play({ media: 'sound:queue-thankyou' });
    
    try {
      const fixedPstnChannel = await this.originateChannel(fixedPstnNumber, bridge.id);
      
      const updatedBridgeData = this.activeBridges.get(bridge.id);
      if (!updatedBridgeData) {
        console.warn(Bridge ${bridge.id} no longer exists after fixed PSTN origination);
        if (fixedPstnChannel) await fixedPstnChannel.hangup();
        return;
      }
      
      updatedBridgeData.fixedPstnChannel = fixedPstnChannel.id;
      
      this.pendingChannels.set(fixedPstnChannel.id, bridge.id);
      
    } catch (err) {
      console.error(Error originating call to fixed PSTN: ${err.message});
      await callingChannel.play({ media: 'sound:call-failed' });
      setTimeout(() => callingChannel.hangup(), 3000);
    }
  }

  async handleCalleeLeg(channel, bridgeId) {
    const bridgeData = this.activeBridges.get(bridgeId);
    if (!bridgeData || bridgeData.terminating) {
      console.error(No bridge found or bridge terminating for callee channel ${channel.id}, bridgeId=${bridgeId});
      await channel.hangup();
      return;
    }
    
    await channel.answer();
    console.log(Answered new callee channel ${channel.id} for bridge ${bridgeId});
  }

  async originateChannel(destination, bridgeId) {
    const endpoint = PJSIP/${destination}@Twilio_example_sg1;

    const originateOptions = {
      endpoint,
      app: 'audio-control',
      appArgs: callee,${bridgeId},
      callerId: '+17194097691',
      timeout: 30,
      variables: { 'CHANNEL(language)': 'en' },
      earlyMedia: true,
    };

    console.log(Originate to ${endpoint}, bridgeId=${bridgeId});
    
    try {
      const channel = await this.client.channels.originate(originateOptions);
      console.log(Originated channel ${channel.id} to ${destination});
      return channel;
    } catch (err) {
      console.error(Error originating channel to ${destination}: ${err.message});
      throw err;
    }
  }

  async onStasisEnd(event, channel) {
    console.log(Channel ${channel.id} left Stasis);
    
    if (this.pendingChannels.has(channel.id)) {
      this.pendingChannels.delete(channel.id);
    }
    
    for (const [bridgeId, bridgeData] of this.activeBridges.entries()) {
      const { bridge, inboundChannel, pstnChannel, fixedPstnChannel } = bridgeData;
      const channelIds = [inboundChannel, pstnChannel, fixedPstnChannel].filter(Boolean);

      if (channelIds.includes(channel.id)) {
        if (bridgeData.terminating) return;

        bridgeData.terminating = true;
        const remainingChannels = channelIds.filter(chId => chId !== channel.id);

        for (const chId of remainingChannels) {
          try {
            const ch = this.client.Channel(chId);
            await ch.hangup();
          } catch (err) {
            console.warn(Error hanging up channel ${chId}:, err.message || err);
          }
        }

        try {
          await bridge.destroy();
        } catch (err) {
          console.warn(Error destroying bridge ${bridgeId}:, err.message || err);
        }

        this.activeBridges.delete(bridgeId);
        
        // Stop transcription if it's running
        if (this.transcriptionSessions.has(bridgeId)) {
          this.stopTranscription(bridgeId);
        }
        
        break;
      }
    }
  }

  async playAudio(bridgeId, audioFile, target = 'all') {
    const bridgeData = this.activeBridges.get(bridgeId);
    if (!bridgeData) throw new Error(Bridge ${bridgeId} not found);

    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Playback timeout')), 10000)
      );

      const playbackPromise = (async () => {
        switch (target) {
          case 'pstn':
            const pstnChannelId = bridgeData.pstnChannel;
            if (!pstnChannelId) throw new Error('PSTN channel not found');
            await this.playAndWait(this.client.Channel(pstnChannelId), audioFile);
            break;

          case 'fixedPstn':
            if (!bridgeData.fixedPstnChannel) throw new Error('Fixed PSTN channel not found');
            await this.playAndWait(this.client.Channel(bridgeData.fixedPstnChannel), audioFile);
            break;

          case 'all':
          default:
            await this.playAndWait(bridgeData.bridge, audioFile);
            break;
        }
      })();

      await Promise.race([playbackPromise, timeoutPromise]);
      return { status: 'success' };
    } catch (error) {
      console.error(Error during playback for target ${target}:, error);
      throw error;
    }
  }

  async playAndWait(target, audioFile) {
    return new Promise(async (resolve, reject) => {
      try {
        if (target.constructor.name === 'Bridge') {
          const playback = await target.play({ media: sound:${audioFile} });
          playback.once('PlaybackFinished', resolve);
          playback.once('PlaybackFailed', reject);
        } else if (target.constructor.name === 'Channel') {
          const snoopChannel = await this.client.channels.snoopChannel({
            channelId: target.id,
            app: 'audio-control',
            appArgs: 'whisper-playback',
            spy: 'none',
            whisper: 'out',
            snoopId: snoop-${uuidv4()}
          });

          snoopChannel.on('StasisStart', async () => {
            console.log(Snoop channel started for whisper playback to ${target.id});
            await snoopChannel.answer();
            const playback = await snoopChannel.play({ media: sound:${audioFile} });

            playback.once('PlaybackFinished', async () => {
              console.log(Playback finished on isolated channel ${target.id});
              await snoopChannel.hangup();
              resolve();
            });

            playback.once('PlaybackFailed', async (err) => {
              console.error(Playback failed on isolated channel:, err);
              await snoopChannel.hangup();
              reject(err);
            });
          });

          snoopChannel.on('StasisEnd', () => {
            console.log(Snoop channel ended for ${target.id});
          });
        } else {
          reject(new Error('Invalid target type'));
        }
      } catch (error) {
        console.error('Error in playAndWait:', error);
        reject(error);
      }
    });
  }

  async startTranscription(bridgeId) {
    const bridgeData = this.activeBridges.get(bridgeId);
    if (!bridgeData) throw new Error(Bridge ${bridgeId} not found);
    
    // Create a snoop channel to capture audio
    const snoopChannel = await this.client.channels.snoopChannel({
      channelId: bridgeData.inboundChannel,
      app: 'audio-control',
      appArgs: 'transcribe',
      spy: 'in',
      whisper: 'none',
      snoopId: transcribe-${uuidv4()}
    });
    
    // Set up AWS Transcribe client
    const transcribeClient = new TranscribeStreamingClient({
      region: 'us-east-1', // Change to your AWS region
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    });
    
    // Create an audio stream from the snoop channel
    const audioStream = async function*() {
      // This would need to be implemented to get audio chunks from the snoop channel
      // You might need to use a raw socket or other method to get the audio data
      while (true) {
        const audioChunk = await getAudioFromSnoopChannel(snoopChannel);
        if (!audioChunk) break;
        
        yield {
          AudioEvent: {
            AudioChunk: audioChunk // This should be PCM encoded audio
          }
        };
      }
    };
    
    // Start transcription
    const command = new StartStreamTranscriptionCommand({
      LanguageCode: 'en-US',
      MediaEncoding: 'pcm',
      MediaSampleRateHertz: 8000, // Adjust based on your call audio sample rate
      AudioStream: audioStream()
    });
    
    try {
      const response = await transcribeClient.send(command);
      
      // Process transcription results
      for await (const event of response.TranscriptResultStream) {
        if (event.TranscriptEvent) {
          const results = event.TranscriptEvent.Transcript.Results;
          if (results.length > 0 && results[0].Alternatives.length > 0) {
            const transcript = results[0].Alternatives[0].Transcript;
            console.log(Transcription: ${transcript});
            
            // Here you could store the transcript, send it to a client, etc.
          }
        }
      }
      
      this.transcriptionSessions.set(bridgeId, response);
    } catch (error) {
      console.error('Error during transcription:', error);
    }
  }

  async stopTranscription(bridgeId) {
    const transcriptionSession = this.transcriptionSessions.get(bridgeId);
    if (transcriptionSession) {
      try {
        await transcriptionSession.TranscriptResultStream.destroy();
        this.transcriptionSessions.delete(bridgeId);
        console.log(Transcription stopped for bridge ${bridgeId});
      } catch (err) {
        console.error(Error stopping transcription for bridge ${bridgeId}:, err);
      }
    }
  }

  async shutdown() {
    this.isShuttingDown = true;
    if (this.client) {
      for (const [bridgeId, data] of this.activeBridges) {
        try {
          await data.bridge.destroy();
          console.log(Destroyed bridge ${bridgeId} during shutdown);
        } catch (err) {
          console.error(Error destroying bridge ${bridgeId}:, err);
        }
      }
      await this.client.close();
      this.client = null;
    }
  }
}

const twoWayController = new TwoWayController();

const logPlaybackError = (error, target) => {
  console.error(Playback error for target ${target}:, error.message || error);
};

app.post('/start-transcription/:bridgeId', async (req, res) => {
  try {
    const { bridgeId } = req.params;
    await twoWayController.startTranscription(bridgeId);
    res.json({ status: 'success', message: 'Transcription started' });
  } catch (err) {
    console.error(Error starting transcription:, err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/stop-transcription/:bridgeId', async (req, res) => {
  try {
    const { bridgeId } = req.params;
    await twoWayController.stopTranscription(bridgeId);
    res.json({ status: 'success', message: 'Transcription stopped' });
  } catch (err) {
    console.error(Error stopping transcription:, err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/play-audio/:bridgeId', async (req, res) => {
  try {
    const { bridgeId } = req.params;
    const { audioFile, target } = req.body;

    if (!audioFile) {
      return res.status(400).json({ error: 'audioFile is required' });
    }

    const validTargets = ['all', 'pstn', 'fixedPstn'];
    if (target && !validTargets.includes(target)) {
      return res.status(400).json({ 
        error: Invalid target. Must be one of: ${validTargets.join(', ')} 
      });
    }

    const result = await twoWayController.playAudio(bridgeId, audioFile, target || 'all');
    res.json(result);
  } catch (err) {
    logPlaybackError(err, req.body.target || 'all');
    res.status(500).json({ error: err.message });
  }
});

app.get('/bridges', async (req, res) => {
  try {
    const bridges = Array.from(twoWayController.activeBridges.entries()).map(([id, data]) => ({
      id,
      pstnChannel: data.pstnChannel,
      fixedPstnChannel: data.fixedPstnChannel,
      inboundChannel: data.inboundChannel
    }));
    res.json({ bridges });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  if (twoWayController.client) {
    res.json({ status: 'healthy', connected: true });
  } else {
    res.status(503).json({ status: 'unhealthy', connected: false });
  }
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM. Shutting down...');
  await twoWayController.shutdown();
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(Server listening on port ${PORT});
  try {
    await twoWayController.init();
  } catch (err) {
    console.error('Fatal error initializing ARI:', err);
    process.exit(1);
  }
});

