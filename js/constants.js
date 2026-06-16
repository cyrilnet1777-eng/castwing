// ── Pure data / config constants ──────────────────────────────────────
// Extracted from index.html — every export is a frozen, side-effect-free value.

export const APP_BUILD = '2026-06-16c';

export const AUDITION_WINDOW_MS = 24 * 60 * 60 * 1000;

export const LINE_TYPE = { SLUG: 'slug', ACTION: 'action', DIALOGUE: 'dialogue' };

export const PARSER_DEBUG = false;

// ── localStorage keys ────────────────────────────────────────────────
export const SETTINGS_KEY     = 'citizentape_user_settings_v3';
export const ACCESS_KEY       = 'citizentape_user_access_v1';
export const PLAN_KEY         = 'citizentape_plan_v2';
export const USER_DATA_V2_KEY = 'citizentape_user_v2';
export const REFERRAL_KEY     = 'citizentape_referral_v1';

// ── TTS / ElevenLabs ────────────────────────────────────────────────
export const ELEVEN_ACCOUNT_BACKOFF_MS = 5 * 60 * 1000;
export const useElevenLabs = true;
export const ITALIENNE_VOICE_ID = 'tZssYepgGaQmegsMEXjK';

// ── Auth ─────────────────────────────────────────────────────────────
export const GOOGLE_CLIENT_ID =
  '580840125965-vrcb9nvptv4mj1ua0v66mq1asl5t6o51.apps.googleusercontent.com';

// ── SFX paths ────────────────────────────────────────────────────────
export const SFX = {
  swoosh:          '/sounds/swoosh.mp3',
  rise:            '/sounds/cinematic-rise.mp3',
  freeze:          '/sounds/freeze.mp3',
  glitch:          '/sounds/glitch.mp3',
  clock:           '/sounds/clock.mp3',
  ambienceValley:  '/sounds/ambience-valley.mp3',
  ambienceHorror:  '/sounds/ambience-horror.mp3',
  ambienceOffice:  '/sounds/ambience-office.mp3',
  countdown:       '/countdown.mp3',
};

// ── Screenplay parsing filters ───────────────────────────────────────
export const BLOCKED_SCREENPLAY_TOKENS = new Set([
  'CUT','CUT TO','FADE','FADE IN','FADE OUT','FADE TO','DISSOLVE','SPLIT','MATCH','MATCH CUT',
  'SMASH CUT','JUMP CUT','CROSS CUT','INTERCUT','TIME CUT','HARD CUT',
  'INTERMISSION','FIN','END','NOIR','BLACK','TITLE','CREDITS','MONTAGE','FLASHBACK',
  'SCENE','SCÈNE','SAISON','EPISODE','ÉPISODE','OPERATION','OPÉRATION','RETOUR','PRESENT','PRÉSENT',
  'INT','EXT','JOUR','NUIT','INTERIEUR','INTÉRIEUR','EXTERIEUR','EXTÉRIEUR','LART','CRIME','L ART DU CRIME',
  'CONTINUED','CONTINUOUS','CONTINUING','MORE','CONT','CONT D','CONTD',
  'TRANSITION','OPENING','CLOSING','PROLOGUE','EPILOGUE','LATER','MOMENTS LATER','SAME TIME',
  'ANGLE ON','CLOSE ON','WIDE ON','PUSH IN','PULL BACK','PAN','TILT','ZOOM','TRACKING',
  'SUPER','SUPERIMPOSE','TITLE CARD','CHYRON','LOWER THIRD','SUBTITLE','CAPTION',
  'MUSIC','MUSIQUE','SFX','SOUND','SON','SILENCE','BEAT','PAUSE',
  'MAIS','PLUS','AVEC','DANS','POUR','SANS','CHEZ','VERS','SOUS','ENTRE','COMME',
  'QUI','QUE','QUOI','DONT','TOUT','TOUS','TOUTE','RIEN','BIEN','DONC','ENCORE','ALORS',
  'ELLE','ELLES','NOUS','VOUS','LEUR','LEURS','CETTE','AUTRE','AUTRES','NOTRE','VOTRE',
  'OUI','NON','PAS','DIS','DIT','FAIT','DIRE','VOIR','ETRE','ÊTRE','FAIRE','AVOIR',
  'AUSSI','TRÈS','TROP','TANT','QUAND','AVANT','APRÈS','APRES','DEPUIS',
  'FLASH','BANG','NOIR','BLANC','BLANCHE','ROUGE','SUITE','NOTE','NOTES',
  'VOIX','TEMPS','LIEU','SOIR','MATIN','DEBUT','DÉBUT',
  'RETOUR','FONDU','FONDU AU NOIR','RETOUR PRÉSENT','RETOUR PRESENT',
  'HERE','THERE','THAT','THIS','THEN','WHEN','WHAT','WHERE','WHICH','ABOUT',
  'FROM','INTO','OVER','JUST','LIKE','BACK','DOWN','ONLY','SOME','THEM','THEY','BEEN',
  'THE','AND','NOT','ARE','WAS','HIS','HER','HAS','HAD','BUT','ALL','CAN','ONE','TWO',
  'MEANWHILE','RESUME','SERIES OF SHOTS','BACK TO SCENE','BACK TO',
]);

export const FALSE_POSITIVE_CUE_PATTERNS = [
  /^(SMILE|MUSIC SWELLS?|LYING|WE COULD HELP YOU|HE IS QUITE GOOD|KIDS CONSPIRATORIALLY|HER BROWSER|INTERROGATION ROOMS|SALVATOR TAKES THAT IN|IS THIS SEAT TAKEN)$/i,
];

// ── Gender name sets (character detection heuristics) ────────────────
export const _MALE_NAMES = new Set(['francois','antoine','cyril','pierre','jean','paul','louis','marc','michel','nicolas','philippe','thomas','jacques','alain','patrick','olivier','julien','sebastien','christophe','stephane','guillaume','vincent','mathieu','alexandre','david','eric','laurent','bruno','frederic','pascal','thierry','gerard','didier','bernard','herve','fabrice','yves','charles','andre','henri','robert','daniel','maxime','hugo','leo','lucas','gabriel','raphael','arthur','nathan','noah','adam','ethan','samuel','victor','theo','felix','emile','romain','damien','fabien','gregoire','william','james','john','michael','richard','mark','steven','peter','kevin','brian','edward','george','henry','alexander','benjamin','anthony','joseph','matthew','christopher','andrew','ryan','jason','jack','oliver','charlie','harry','oscar','archie','alfie','liam','carlos','diego','miguel','alejandro','pedro','pablo','rafael','javier','fernando','antonio','roberto','marco','giuseppe','francesco','luca','matteo','giovanni','stefan','hans','karl','friedrich','heinrich','wolfgang','klaus','dieter','werner','rainer','ahmed','omar','ali','hassan','hussein','khalid','mohammad','ibrahim','yusuf','mehmet','mustafa','ahmet','emre','burak','ivan','dmitri','sergei','nikolai','alexei','vladimir','boris','yuri','andrei','hiroshi','takeshi','kenji','wei','ming','chen','jun','haruto','ren','takumi']);

export const _FEMALE_NAMES = new Set(['florence','virginie','adele','sophie','marie','anne','catherine','nathalie','isabelle','christine','veronique','sandrine','valerie','patricia','sylvie','monique','brigitte','francoise','martine','danielle','helene','cecile','camille','lea','emma','chloe','manon','jade','louise','alice','ines','lola','charlotte','juliette','clara','lucie','margaux','pauline','agathe','oceane','sarah','laura','julie','audrey','clemence','elodie','marine','melanie','amandine','aurelie','mary','elizabeth','jennifer','jessica','amanda','ashley','emily','samantha','rachel','nicole','angela','michelle','stephanie','rebecca','olivia','amelia','isla','ava','mia','sophia','ella','grace','freya','lily','maria','carmen','ana','lucia','rosa','elena','pilar','sofia','valentina','giulia','francesca','chiara','anna','marta','defne','elif','zeynep','ayse','fatma','merve','nour','salma','fatima','layla','aisha','hana','yui','sakura','mei','ling','ananya','priya','alina','natasha','ekaterina','olga','tatiana','svetlana','minji','soo','yuna']);
