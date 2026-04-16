/**
 * Game logic engine for Caption Clash.
 *
 * Game states: 'lobby' -> 'captioning' -> 'voting' -> 'results' -> 'captioning' (loop)
 * When a player reaches 6 wins, state goes to 'gameover'.
 */
const { v4: uuidv4 } = require('uuid');
const { cleanText } = require('./profanityFilter');
const { getRandomImage, resetImagePool } = require('./imageGenerator');

const CAPTION_TIME = 60;       // seconds
const VOTE_TIME = 120;         // seconds
const RESULTS_TIME = 10;       // seconds
const MAX_PLAYERS = 6;
const CAPTION_CHAR_LIMIT = 100;
const WINS_TO_END = 6;

// Avatar options (simple colored avatars)
const AVATAR_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD',
  '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9', '#F8C471', '#82E0AA',
];

const AVATAR_EMOJIS = [
  '😎', '🤠', '🦊', '🐸', '🐱', '🐶',
  '🦁', '🐼', '🐨', '🦄', '🐙', '🎃',
];

class Game {
  constructor(roomCode) {
    this.roomCode = roomCode;
    this.state = 'lobby';
    this.players = new Map();    // socketId -> player object
    this.currentImage = null;
    this.captions = new Map();   // socketId -> caption text
    this.votes = new Map();      // voterId -> captionAuthorId
    this.roundNumber = 0;
    this.timer = null;
    this.timeRemaining = 0;
    this.hostId = null;
    this.usedAvatarIndices = new Set();
  }

  /**
   * Add a player to the game.
   * @returns {{ success: boolean, error?: string, player?: object }}
   */
  addPlayer(socketId, username) {
    if (this.players.size >= MAX_PLAYERS) {
      return { success: false, error: 'Game is full (max 6 players)' };
    }
    if (this.state !== 'lobby') {
      return { success: false, error: 'Game already in progress' };
    }

    const sanitizedName = cleanText(username.trim()).substring(0, 20);
    if (!sanitizedName) {
      return { success: false, error: 'Invalid username' };
    }

    // Check duplicate names
    for (const p of this.players.values()) {
      if (p.username.toLowerCase() === sanitizedName.toLowerCase()) {
        return { success: false, error: 'Username already taken' };
      }
    }

    // Assign avatar
    let avatarIndex = 0;
    for (let i = 0; i < AVATAR_EMOJIS.length; i++) {
      if (!this.usedAvatarIndices.has(i)) {
        avatarIndex = i;
        this.usedAvatarIndices.add(i);
        break;
      }
    }

    const player = {
      id: socketId,
      username: sanitizedName,
      score: 0,
      captionsWon: 0,
      gamesWon: 0,
      avatarColor: AVATAR_COLORS[avatarIndex],
      avatarEmoji: AVATAR_EMOJIS[avatarIndex],
      avatarIndex,
      connected: true,
    };

    this.players.set(socketId, player);

    if (!this.hostId) {
      this.hostId = socketId;
    }

    return { success: true, player };
  }

  /**
   * Remove a player from the game.
   */
  removePlayer(socketId) {
    const player = this.players.get(socketId);
    if (player) {
      this.usedAvatarIndices.delete(player.avatarIndex);
      this.players.delete(socketId);

      // Transfer host
      if (this.hostId === socketId) {
        const remaining = [...this.players.keys()];
        this.hostId = remaining.length > 0 ? remaining[0] : null;
      }
    }
    return this.players.size;
  }

  /**
   * Start a new round of captioning.
   * @returns {Promise<object>} Round data including the image
   */
  async startRound(onTick, onPhaseEnd) {
    this.roundNumber++;
    this.captions.clear();
    this.votes.clear();
    this.state = 'captioning';

    this.currentImage = await getRandomImage();

    this.startTimer(CAPTION_TIME, onTick, () => {
      onPhaseEnd('captioning');
    });

    return {
      state: this.state,
      image: this.currentImage,
      roundNumber: this.roundNumber,
      timeRemaining: this.timeRemaining,
    };
  }

  /**
   * Submit a caption for the current round.
   */
  submitCaption(socketId, caption) {
    if (this.state !== 'captioning') {
      return { success: false, error: 'Not in captioning phase' };
    }
    if (!this.players.has(socketId)) {
      return { success: false, error: 'Player not in game' };
    }
    if (this.captions.has(socketId)) {
      return { success: false, error: 'Caption already submitted' };
    }

    let text = caption.trim().substring(0, CAPTION_CHAR_LIMIT);
    text = cleanText(text);

    if (!text) {
      return { success: false, error: 'Caption cannot be empty' };
    }

    this.captions.set(socketId, text);

    return {
      success: true,
      totalSubmitted: this.captions.size,
      totalPlayers: this.players.size,
      allSubmitted: this.captions.size === this.players.size,
    };
  }

  /**
   * Start the voting phase.
   */
  startVoting(onTick, onPhaseEnd) {
    this.state = 'voting';
    this.votes.clear();

    this.startTimer(VOTE_TIME, onTick, () => {
      onPhaseEnd('voting');
    });

    // Build caption list (anonymized for voting)
    const captionList = [];
    for (const [playerId, text] of this.captions) {
      captionList.push({ id: playerId, text });
    }

    // Shuffle captions so order is random
    for (let i = captionList.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [captionList[i], captionList[j]] = [captionList[j], captionList[i]];
    }

    return {
      state: this.state,
      captions: captionList,
      image: this.currentImage,
      timeRemaining: this.timeRemaining,
    };
  }

  /**
   * Submit a vote.
   */
  submitVote(voterId, captionAuthorId) {
    if (this.state !== 'voting') {
      return { success: false, error: 'Not in voting phase' };
    }
    if (!this.players.has(voterId)) {
      return { success: false, error: 'Player not in game' };
    }
    if (voterId === captionAuthorId) {
      return { success: false, error: 'Cannot vote for your own caption' };
    }
    if (!this.captions.has(captionAuthorId)) {
      return { success: false, error: 'Invalid caption selection' };
    }
    if (this.votes.has(voterId)) {
      return { success: false, error: 'Already voted' };
    }

    this.votes.set(voterId, captionAuthorId);

    // Eligible voters are players who submitted captions
    const eligibleVoters = [...this.captions.keys()];
    const totalVoters = eligibleVoters.length;

    return {
      success: true,
      totalVoted: this.votes.size,
      totalVoters,
      allVoted: this.votes.size >= totalVoters,
    };
  }

  /**
   * Tally votes and compute results.
   */
  getResults() {
    this.state = 'results';
    this.clearTimer();

    // Tally votes
    const voteCounts = new Map();
    for (const authorId of this.votes.values()) {
      voteCounts.set(authorId, (voteCounts.get(authorId) || 0) + 1);
    }

    // Find winner(s)
    let maxVotes = 0;
    for (const count of voteCounts.values()) {
      if (count > maxVotes) maxVotes = count;
    }

    const winners = [];
    if (maxVotes > 0) {
      for (const [playerId, count] of voteCounts) {
        if (count === maxVotes) {
          winners.push(playerId);
        }
      }
    }

    // Award points
    for (const winnerId of winners) {
      const player = this.players.get(winnerId);
      if (player) {
        player.score++;
        player.captionsWon++;
      }
    }

    // Build results
    const results = [];
    for (const [playerId, text] of this.captions) {
      const player = this.players.get(playerId);
      results.push({
        playerId,
        username: player ? player.username : 'Unknown',
        avatar: player ? { color: player.avatarColor, emoji: player.avatarEmoji } : null,
        caption: text,
        votes: voteCounts.get(playerId) || 0,
        isWinner: winners.includes(playerId),
      });
    }
    results.sort((a, b) => b.votes - a.votes);

    // Check if anyone has reached the win threshold
    let gameWinner = null;
    for (const player of this.players.values()) {
      if (player.score >= WINS_TO_END) {
        gameWinner = {
          id: player.id,
          username: player.username,
          avatar: { color: player.avatarColor, emoji: player.avatarEmoji },
          score: player.score,
        };
        player.gamesWon++;
        break;
      }
    }

    if (gameWinner) {
      this.state = 'gameover';
    }

    return {
      state: this.state,
      results,
      winners: winners.map(id => {
        const p = this.players.get(id);
        return p ? { id, username: p.username, caption: this.captions.get(id) } : null;
      }).filter(Boolean),
      scoreboard: this.getScoreboard(),
      image: this.currentImage,
      gameWinner,
    };
  }

  /**
   * Get current scoreboard.
   */
  getScoreboard() {
    const board = [];
    for (const player of this.players.values()) {
      board.push({
        id: player.id,
        username: player.username,
        score: player.score,
        captionsWon: player.captionsWon,
        gamesWon: player.gamesWon,
        avatar: { color: player.avatarColor, emoji: player.avatarEmoji },
        isHost: player.id === this.hostId,
      });
    }
    board.sort((a, b) => b.score - a.score);
    return board;
  }

  /**
   * Reset for a new game (same players).
   */
  resetGame() {
    for (const player of this.players.values()) {
      player.score = 0;
      player.captionsWon = 0;
    }
    this.roundNumber = 0;
    this.captions.clear();
    this.votes.clear();
    this.currentImage = null;
    this.state = 'lobby';
    this.clearTimer();
    resetImagePool();
  }

  /**
   * Get player list for lobby.
   */
  getPlayerList() {
    const list = [];
    for (const player of this.players.values()) {
      list.push({
        id: player.id,
        username: player.username,
        avatar: { color: player.avatarColor, emoji: player.avatarEmoji },
        gamesWon: player.gamesWon,
        captionsWon: player.captionsWon,
        isHost: player.id === this.hostId,
      });
    }
    return list;
  }

  // --- Timer helpers ---

  startTimer(seconds, onTick, onEnd) {
    this.clearTimer();
    this.timeRemaining = seconds;
    this.timer = setInterval(() => {
      this.timeRemaining--;
      onTick(this.timeRemaining);
      if (this.timeRemaining <= 0) {
        this.clearTimer();
        onEnd();
      }
    }, 1000);
  }

  clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Check if all captions have been submitted.
   */
  allCaptionsSubmitted() {
    return this.captions.size >= this.players.size;
  }

  /**
   * Check if all votes have been submitted.
   */
  allVotesSubmitted() {
    const eligibleVoters = [...this.captions.keys()];
    return this.votes.size >= eligibleVoters.length;
  }

  destroy() {
    this.clearTimer();
    this.players.clear();
    this.captions.clear();
    this.votes.clear();
  }
}

// Room management
const rooms = new Map();

function createRoom() {
  const code = generateRoomCode();
  const game = new Game(code);
  rooms.set(code, game);
  return game;
}

function getRoom(code) {
  return rooms.get(code?.toUpperCase());
}

function deleteRoom(code) {
  const game = rooms.get(code);
  if (game) {
    game.destroy();
    rooms.delete(code);
  }
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms.has(code));
  return code;
}

module.exports = { Game, createRoom, getRoom, deleteRoom };
