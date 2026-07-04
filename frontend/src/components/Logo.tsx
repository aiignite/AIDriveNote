import React from 'react';

type LogoProps = {
  size?: number;
  className?: string;
};

/** AIDriveNote 品牌标识（官方图标） */
const Logo: React.FC<LogoProps> = ({ size = 28, className = '' }) => {
  const src =
    size <= 32 ? '/icons/icon-32.png'
    : size <= 64 ? '/icons/icon-64.png'
    : size <= 128 ? '/icons/icon-128.png'
    : '/icons/icon-256.png';

  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className={className}
      aria-hidden
      draggable={false}
    />
  );
};

export default Logo;
